import { describe, expect, it, vi } from "vitest";
import { runRecoveryIndexBatch } from "./recovery";

const input = {
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

describe("recovery index rebuild", () => {
  it("rebuilds only the bounded canonical inputs returned by the database", async () => {
    const rebuild = vi.fn().mockResolvedValue(undefined);
    await expect(
      runRecoveryIndexBatch({
        candidates: vi.fn().mockResolvedValue([input]),
        rebuild
      })
    ).resolves.toEqual({ rebuilt: 1 });
    expect(rebuild).toHaveBeenCalledWith(input);
  });

  it("fails the batch when a canonical original cannot be rebuilt", async () => {
    await expect(
      runRecoveryIndexBatch({
        candidates: vi.fn().mockResolvedValue([input]),
        rebuild: vi.fn().mockRejectedValue(new Error("generation unavailable"))
      })
    ).rejects.toThrow("generation unavailable");
  });
});
