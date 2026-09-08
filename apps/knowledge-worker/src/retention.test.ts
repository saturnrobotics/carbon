import { describe, expect, it, vi } from "vitest";
import { createImmutableObjectDeleter, runRetentionBatch } from "./retention";

const records = [
  {
    recordKind: "intake" as const,
    recordId: "intake-synthetic",
    companyId: "company-synthetic",
    objects: [
      { objectKey: "raw/a.pdf", generation: "17" },
      { objectKey: "raw/b.pdf", generation: "18" }
    ]
  }
];

describe("retention orchestration", () => {
  it("pins the storage deletion to the selected generation", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const file = vi.fn().mockReturnValue({ delete: remove });
    const bucket = vi.fn().mockReturnValue({ file });
    await createImmutableObjectDeleter({ bucket } as never, "knowledge-bucket")(
      "raw/a.pdf",
      "17"
    );
    expect(bucket).toHaveBeenCalledWith("knowledge-bucket");
    expect(file).toHaveBeenCalledWith("raw/a.pdf", { generation: "17" });
    expect(remove).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("deletes only the candidate's immutable generations before finalizing", async () => {
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const finalize = vi.fn().mockResolvedValue({
      intakes: 1,
      documentVersions: 0,
      conversations: 0,
      chunks: 0,
      audits: 0,
      outbox: 0,
      requestWindows: 0
    });

    const result = await runRetentionBatch({
      candidates: vi.fn().mockResolvedValue(records),
      deleteObject,
      finalize
    });

    expect(deleteObject.mock.calls).toEqual([
      ["raw/a.pdf", "17"],
      ["raw/b.pdf", "18"]
    ]);
    expect(finalize).toHaveBeenCalledWith(records);
    expect(result.deletedObjects).toBe(2);
  });

  it("does not finalize database deletion when an object generation fails", async () => {
    const finalize = vi.fn();
    await expect(
      runRetentionBatch({
        candidates: vi.fn().mockResolvedValue(records),
        deleteObject: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("immutable delete failed")),
        finalize
      })
    ).rejects.toThrow("immutable delete failed");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("finalizes candidates that have no retained object references", async () => {
    const withoutObjects = [{ ...records[0], objects: [] }];
    const finalize = vi.fn().mockResolvedValue({
      intakes: 1,
      documentVersions: 0,
      conversations: 2,
      chunks: 0,
      audits: 0,
      outbox: 0,
      requestWindows: 0
    });
    const result = await runRetentionBatch({
      candidates: vi.fn().mockResolvedValue(withoutObjects),
      deleteObject: vi.fn(),
      finalize
    });
    expect(finalize).toHaveBeenCalledWith(withoutObjects);
    expect(result.deletedObjects).toBe(0);
  });
});
