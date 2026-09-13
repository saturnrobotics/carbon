import { describe, expect, it } from "vitest";
import { parseStoredExtraction } from "./contracts";
import { createExtraction, extractionFingerprint } from "./extraction.server";
import { captureIdentity } from "./intake.server";

describe("captureIdentity", () => {
  it("deduplicates the same immutable object for one source without crossing ACLs", () => {
    const input = {
      kind: "object" as const,
      objectKey: "intake/a.pdf",
      generation: "7",
      sha256: "a".repeat(64),
      mimeType: "application/pdf",
      bytes: 3
    };
    expect(
      captureIdentity({
        sourceId: "drive-a",
        ownerId: "u",
        acl: "engineering",
        input
      }).idempotencyKey
    ).toBe(
      captureIdentity({
        sourceId: "drive-a",
        ownerId: "u",
        acl: "engineering",
        input
      }).idempotencyKey
    );
    expect(
      captureIdentity({
        sourceId: "drive-b",
        ownerId: "u",
        acl: "private",
        input
      }).idempotencyKey
    ).not.toBe(
      captureIdentity({
        sourceId: "drive-a",
        ownerId: "u",
        acl: "engineering",
        input
      }).idempotencyKey
    );
  });
});

it("fingerprints persisted JSONB independently of object key order", () => {
  expect(
    extractionFingerprint({
      fields: { title: "Manual" },
      evidence: {},
      unresolved: [],
      warnings: []
    })
  ).toBe(
    extractionFingerprint({
      warnings: [],
      unresolved: [],
      evidence: {},
      fields: { title: "Manual" }
    })
  );
});

describe("createExtraction", () => {
  it("rejects parser output that cannot fit the immutable database envelope", () => {
    expect(() =>
      createExtraction({
        fields: { body: "x".repeat(70_000) },
        evidence: {},
        warnings: []
      })
    ).toThrow("byte limit");
  });
  it("keeps bounded page evidence for long manuals", () => {
    const extraction = createExtraction({
      fields: { title: "Synthetic long manual" },
      evidence: {
        body: Array.from({ length: 100 }, (_, index) => ({
          page: index + 1,
          text: `page ${index + 1} ${"x".repeat(1_000)}`
        }))
      },
      warnings: []
    });
    expect(extraction.evidence.body).toHaveLength(100);
  });
});

describe("createExtraction typed proposals", () => {
  it("recalibrates the parser's confidence and marks a weak proposal unresolved like a field with no evidence", () => {
    const extraction = createExtraction({
      fields: { title: "Manual", orphan: "no evidence" },
      evidence: { title: [{ page: 1, text: "Manual" }] },
      sourceKind: "ocr",
      proposed: {
        mpn: {
          value: "MTR-100",
          confidence: 1,
          evidence: [{ page: 1, region: "header" }, { page: 2 }, { page: 3 }]
        },
        revision: { value: "A", confidence: 0.6, evidence: [{ page: 4 }] }
      }
    });
    expect(extraction.contractVersion).toBe(2);
    expect(extraction.proposed.mpn).toEqual({
      value: "MTR-100",
      confidence: 0.9,
      evidence: [{ page: 1, region: "header" }, { page: 2 }, { page: 3 }]
    });
    expect(extraction.proposed.revision?.confidence).toBeCloseTo(0.432);
    expect(extraction.unresolved).toEqual(["orphan", "revision"]);
  });

  it("never lets a parser assert confidence without evidence", () => {
    const extraction = createExtraction({
      fields: {},
      evidence: {},
      sourceKind: "text-layer",
      proposed: {
        manufacturer: { value: "Example", confidence: 1, evidence: [] }
      }
    });
    expect(extraction.proposed.manufacturer?.confidence).toBe(0);
    expect(extraction.unresolved).toEqual(["manufacturer"]);
  });

  it("keeps typed units on measurements and rejects them on identity fields", () => {
    const extraction = createExtraction({
      fields: {},
      evidence: {},
      sourceKind: "text-layer",
      proposed: {
        title: {
          value: "Manual",
          confidence: 1,
          unit: "mm",
          evidence: [{ page: 1 }]
        },
        documentType: {
          value: "datasheet",
          confidence: 1,
          evidence: [{ page: 1 }, { page: 2 }, { page: 3 }]
        },
        measurements: {
          ratedVoltage: {
            value: 24,
            unit: "V",
            confidence: 1,
            evidence: [{ page: 5 }, { page: 6 }, { page: 7 }]
          },
          "bad key": { value: 1, unit: "V", confidence: 1, evidence: [] },
          length: { value: 3, unit: "furlong", confidence: 1, evidence: [] }
        }
      }
    });
    expect(extraction.proposed.title).toBeUndefined();
    expect(extraction.proposed.documentType?.value).toBe("datasheet");
    expect(extraction.proposed.measurements).toEqual({
      ratedVoltage: {
        value: 24,
        unit: "V",
        confidence: 1,
        evidence: [{ page: 5 }, { page: 6 }, { page: 7 }]
      }
    });
    expect(extraction.unresolved).toEqual([]);
    expect(extraction.warnings).toEqual([
      'Parser proposal "title" was discarded: invalid proposal',
      'Parser proposal "measurements.bad key" was discarded: invalid measurement',
      'Parser proposal "measurements.length" was discarded: invalid measurement'
    ]);
  });

  it("discards unknown or malformed proposals with a warning instead of failing intake", () => {
    const extraction = createExtraction({
      fields: {},
      evidence: {},
      proposed: {
        serialNumber: { value: "x", confidence: 1, evidence: [{ page: 1 }] },
        mpn: { value: "", confidence: 2, evidence: [{ page: 0 }] }
      }
    });
    expect(extraction.proposed).toEqual({});
    expect(extraction.unresolved).toEqual([]);
    expect(extraction.warnings).toEqual([
      'Parser proposal "serialNumber" was discarded: not a typed field',
      'Parser proposal "mpn" was discarded: invalid proposal'
    ]);
    expect(
      createExtraction({ fields: {}, evidence: {}, proposed: ["mpn"] }).warnings
    ).toEqual(["Parser proposed fields were not an object and were discarded"]);
  });

  it("falls back to the least trusted prior when the parser does not say how it read the document", () => {
    const proposed = {
      mpn: {
        value: "MTR-100",
        confidence: 1,
        evidence: [{ page: 1 }, { page: 2 }, { page: 3 }]
      }
    };
    expect(
      createExtraction({ fields: {}, evidence: {}, proposed }).proposed.mpn
        ?.confidence
    ).toBe(
      createExtraction({
        fields: {},
        evidence: {},
        proposed,
        sourceKind: "model"
      }).proposed.mpn?.confidence
    );
    expect(
      createExtraction({
        fields: {},
        evidence: {},
        proposed,
        sourceKind: "llm-v9"
      }).proposed.mpn?.confidence
    ).toBeCloseTo(0.85);
  });
});

describe("parseStoredExtraction", () => {
  it("reads a version-1 generation without typed proposals", () => {
    expect(
      parseStoredExtraction({
        fields: { title: "Manual" },
        evidence: { title: [{ page: 1, text: "Manual" }] },
        unresolved: [],
        warnings: []
      })
    ).toEqual({
      contractVersion: 1,
      fields: { title: "Manual" },
      proposed: {},
      evidence: { title: [{ page: 1, text: "Manual" }] },
      unresolved: [],
      warnings: []
    });
  });

  it("round-trips a version-2 generation produced by createExtraction", () => {
    const extraction = createExtraction({
      fields: { title: "Manual" },
      evidence: { title: [{ page: 1, text: "Manual" }] },
      sourceKind: "text-layer",
      proposed: {
        measurements: {
          ratedVoltage: {
            value: 24,
            unit: "V",
            confidence: 0.5,
            evidence: [{ page: 5 }]
          }
        }
      }
    });
    expect(
      extraction.proposed.measurements?.ratedVoltage?.confidence
    ).toBeCloseTo(0.4);
    expect(extraction.unresolved).toEqual(["measurements.ratedVoltage"]);
    expect(
      parseStoredExtraction(JSON.parse(JSON.stringify(extraction)))
    ).toEqual(extraction);
  });
});
