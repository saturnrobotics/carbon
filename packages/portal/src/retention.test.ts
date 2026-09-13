import { describe, expect, it, vi } from "vitest";
import {
  finalizeRetention,
  recoveryIndexCandidates,
  retentionCandidates
} from "./retention.server";

const record = {
  recordKind: "intake" as const,
  recordId: "intake-synthetic",
  companyId: "company-synthetic",
  objects: [{ objectKey: "intake/synthetic.pdf", generation: "12" }]
};

describe("retention database boundary", () => {
  it("accepts only bounded immutable object-generation candidates", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [record] });
    await expect(retentionCandidates({ query } as never, 25)).resolves.toEqual([
      record
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("$1"), [25]);

    query.mockResolvedValueOnce({
      rows: [{ ...record, objects: [{ objectKey: "x", generation: "latest" }] }]
    });
    await expect(retentionCandidates({ query } as never)).rejects.toThrow();
  });

  it("sends an exact deletion receipt to the fixed-policy finalizer", async () => {
    const stats = {
      intakes: 1,
      documentVersions: 0,
      conversations: 2,
      chunks: 3,
      audits: 4,
      outbox: 5,
      requestWindows: 6
    };
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ result: stats, requestWindows: 6 }] });
    await expect(
      finalizeRetention({ query } as never, [record])
    ).resolves.toEqual(stats);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("cleanup_operational_retention"),
      [JSON.stringify([record])]
    );
  });

  it("validates bounded immutable recovery inputs", async () => {
    const candidate = {
      companyId: "company-synthetic",
      sourceId: "source-synthetic",
      documentId: "document-synthetic",
      versionId: "version-synthetic",
      objectKey: "documents/manual.pdf",
      generation: "21",
      contentHash: "a".repeat(64),
      mimeType: "application/pdf",
      parserVersion: "parser-v1"
    };
    const query = vi.fn().mockResolvedValue({ rows: [candidate] });
    await expect(
      recoveryIndexCandidates({ query } as never, 50)
    ).resolves.toEqual([candidate]);
    query.mockResolvedValueOnce({
      rows: [{ ...candidate, generation: "latest" }]
    });
    await expect(recoveryIndexCandidates({ query } as never)).rejects.toThrow();
  });
});
