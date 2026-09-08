import { describe, expect, it, vi } from "vitest";
import {
  checkDriveFileAccess,
  downloadDriveDocument,
  syncDriveChanges
} from "./drive-client";

describe("Drive API client", () => {
  it("persists a page before requesting the next change token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          nextPageToken: "page-2",
          changes: [
            {
              fileId: "file",
              file: {
                id: "file",
                driveId: "drive",
                name: "Manual",
                version: "7",
                permissions: [
                  {
                    id: "permission",
                    type: "domain",
                    domain: "example.com",
                    role: "reader"
                  }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      )
    );
    await expect(
      syncDriveChanges({
        accessToken: "token",
        pageToken: "page-1",
        driveId: "drive",
        known: () => undefined,
        fetchImpl,
        onPage: async () => {
          throw new Error("persist failed");
        }
      })
    ).rejects.toThrow("persist failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the current user's delegated token for a live access check", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "file",
          trashed: false,
          capabilities: { canDownload: true }
        }),
        { status: 200 }
      )
    );
    await expect(
      checkDriveFileAccess("delegated", "file", fetchImpl)
    ).resolves.toBe(true);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer delegated" }
    });
  });

  it("exports native Google documents and bounds the returned bytes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("pdf", {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "3" }
      })
    );
    await expect(
      downloadDriveDocument(
        "connector",
        "file",
        "application/vnd.google-apps.document",
        { fetchImpl, maxBytes: 4 }
      )
    ).resolves.toMatchObject({
      mimeType: "application/pdf",
      bytes: new Uint8Array(Buffer.from("pdf"))
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/export?");
    await expect(
      downloadDriveDocument("connector", "file", "application/pdf", {
        fetchImpl: async () =>
          new Response("large", {
            headers: {
              "content-type": "application/pdf",
              "content-length": "5"
            }
          }),
        maxBytes: 4
      })
    ).rejects.toThrow("byte limit");
  });
});
