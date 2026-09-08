import { describe, expect, it, vi } from "vitest";
import { syncDrivePages } from "./drive-sync";

describe("syncDrivePages", () => {
  it("stores each cursor only after its page mutations commit", async () => {
    const persisted: string[] = [];
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ nextCursor: "page-2", changes: [], done: false })
      .mockResolvedValueOnce({ nextCursor: "done", changes: [], done: true });
    await syncDrivePages("page-1", readPage, async (page) => {
      persisted.push(page.nextCursor);
    });
    expect(persisted).toEqual(["page-2", "done"]);
    expect(readPage).toHaveBeenNthCalledWith(2, "page-2");
  });

  it("does not read or expose the next cursor when persistence fails", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValue({ nextCursor: "page-2", changes: [], done: false });
    await expect(
      syncDrivePages("page-1", readPage, async () => {
        throw new Error("database unavailable");
      })
    ).rejects.toThrow("database unavailable");
    expect(readPage).toHaveBeenCalledTimes(1);
  });
});
