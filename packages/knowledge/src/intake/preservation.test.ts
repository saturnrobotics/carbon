import { describe, expect, it } from "vitest";
import { buildPublication } from "./publish.server";
import { reconcileExtraction } from "./reconciliation";

describe("reconcileExtraction", () => {
  it("preserves a corrected field and requires acknowledgement of new evidence", () => {
    const output = reconcileExtraction(
      { fields: { mpn: "old" }, evidence: {}, unresolved: [], warnings: [] },
      {
        fields: { mpn: "model" },
        evidence: { mpn: [{ page: 1, text: "model" }] },
        unresolved: [],
        warnings: []
      },
      { mpn: { value: "reviewed", decision: "corrected", evidence: ["p1"] } }
    );
    expect(output.fields.mpn).toBe("reviewed");
    expect(output.unresolved).toContain("mpn");
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
