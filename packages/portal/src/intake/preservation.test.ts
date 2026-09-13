import { describe, expect, it } from "vitest";
import { type Extraction, parseStoredExtraction } from "./contracts";
import { createExtraction } from "./extraction.server";
import { buildPublication } from "./publish.server";
import { reconcileExtraction } from "./reconciliation";

const storedVersionOne = parseStoredExtraction({
  fields: { mpn: "old" },
  evidence: {},
  unresolved: [],
  warnings: []
});

function generation(overrides: Partial<Extraction>): Extraction {
  return {
    contractVersion: 2,
    fields: {},
    proposed: {},
    evidence: {},
    unresolved: [],
    warnings: [],
    ...overrides
  };
}

describe("reconcileExtraction", () => {
  it("preserves a corrected field and requires acknowledgement of new evidence", () => {
    const output = reconcileExtraction(
      storedVersionOne,
      generation({
        fields: { mpn: "model" },
        evidence: { mpn: [{ page: 1, text: "model" }] }
      }),
      { mpn: { value: "reviewed", decision: "corrected", evidence: ["p1"] } }
    );
    expect(output.fields.mpn).toBe("reviewed");
    expect(output.unresolved).toContain("mpn");
  });

  it("carries a correction over silently when the parser no longer emits the field", () => {
    const output = reconcileExtraction(
      storedVersionOne,
      generation({
        fields: { title: "Manual" },
        evidence: { title: [{ page: 1, text: "Manual" }] }
      }),
      {
        partNumber: { value: "MTR-100", decision: "corrected", evidence: [] }
      }
    );
    expect(output.fields.partNumber).toBe("MTR-100");
    expect(output.unresolved).toEqual([]);
  });

  it("keeps a typed correction over a disagreeing re-extracted proposal and asks for acknowledgement", () => {
    const next = createExtraction({
      fields: { title: "Manual" },
      evidence: { title: [{ page: 1, text: "Manual" }] },
      sourceKind: "text-layer",
      proposed: {
        mpn: {
          value: "MTR-200",
          confidence: 0.95,
          evidence: [{ page: 2 }, { page: 3 }, { page: 4 }]
        }
      }
    });
    expect(next.unresolved).toEqual([]);
    const output = reconcileExtraction(storedVersionOne, next, {
      partNumber: { value: "MTR-100", decision: "corrected", evidence: [] }
    });
    expect(output.fields.partNumber).toBe("MTR-100");
    expect(output.proposed.mpn?.value).toBe("MTR-200");
    expect(output.unresolved).toEqual(["mpn"]);
  });

  it("stays quiet when the re-extracted typed proposal agrees with the saved decision", () => {
    const next = createExtraction({
      fields: {},
      evidence: {},
      sourceKind: "text-layer",
      proposed: {
        mpn: {
          value: "MTR-100",
          confidence: 0.95,
          evidence: [{ page: 2 }, { page: 3 }, { page: 4 }]
        },
        manufacturer: {
          value: "Example Manufacturing",
          confidence: 0.95,
          evidence: [{ page: 1 }, { page: 2 }, { page: 3 }]
        }
      }
    });
    const output = reconcileExtraction(storedVersionOne, next, {
      partNumber: { value: "MTR-100", decision: "corrected", evidence: [] },
      manufacturer: {
        value: "Example Manufacturing",
        decision: "accepted",
        evidence: []
      }
    });
    expect(output.fields.partNumber).toBe("MTR-100");
    expect(output.unresolved).toEqual([]);
  });

  it("keeps a low-confidence re-extracted proposal unresolved even after a correction", () => {
    const next = createExtraction({
      fields: {},
      evidence: {},
      sourceKind: "ocr",
      proposed: {
        revision: { value: "B", confidence: 0.5, evidence: [{ page: 9 }] }
      }
    });
    expect(next.unresolved).toEqual(["revision"]);
    const output = reconcileExtraction(storedVersionOne, next, {
      revision: { value: "A", decision: "corrected", evidence: [] }
    });
    expect(output.fields.revision).toBe("A");
    expect(output.unresolved).toEqual(["revision"]);
  });

  it("ignores rejected decisions for typed proposals", () => {
    const next = createExtraction({
      fields: {},
      evidence: {},
      sourceKind: "text-layer",
      proposed: {
        mpn: {
          value: "MTR-200",
          confidence: 1,
          evidence: [{ page: 2 }, { page: 3 }, { page: 4 }]
        }
      }
    });
    const output = reconcileExtraction(storedVersionOne, next, {
      partNumber: { value: "MTR-100", decision: "rejected", evidence: [] }
    });
    expect(output.fields.partNumber).toBeUndefined();
    expect(output.unresolved).toEqual([]);
  });
});

describe("buildPublication", () => {
  it("derives an immutable version and chunks from persisted capture and extraction data", () => {
    const publication = buildPublication({
      intakeId: "intake",
      sourceId: "source",
      ownerId: "user",
      generation: "3",
      inputRefs: [
        {
          kind: "object",
          objectKey: "intake/manual.pdf",
          generation: "42",
          sha256: "a".repeat(64),
          mimeType: "application/pdf",
          bytes: 6,
          acl: "internal"
        }
      ],
      extraction: { title: "Motor manual", kind: "manual" },
      extractionOutput: {
        fields: { title: "Motor manual" },
        evidence: { title: [{ page: 1, text: "Motor manual" }] },
        unresolved: [],
        warnings: []
      },
      reviewDecisions: {
        title: { value: "Motor manual" },
        manufacturer: { value: "Example Manufacturing" },
        partNumber: { value: "MTR-100" },
        revision: { value: "A" },
        machine: { value: "Assembly cell" }
      }
    });
    expect(publication.version).toMatchObject({
      objectGeneration: "42",
      contentHash: "a".repeat(64),
      sourceRevision: "intake:3"
    });
    expect(publication.version.reviewedMetadata).toEqual({
      title: "Motor manual",
      manufacturer: "Example Manufacturing",
      partNumber: "MTR-100",
      revision: "A",
      machine: "Assembly cell"
    });
    expect(publication.chunks[1]).toMatchObject({
      page: 1,
      text: "Motor manual"
    });
    expect(publication.chunks[0]?.text).toContain("MTR-100");
  });
});
