import { describe, expect, it, vi } from "vitest";
import {
  checkDriveFileAccess,
  createDriveApiClient,
  downloadDriveDocument,
  googleFileToDocument,
  normalizeGooglePermissions
} from "./drive-client";

function batchResponse(
  parts: Array<{ id: string; status: number; body: unknown }>
) {
  const boundary = "batch_synthetic";
  const text = `${parts
    .map(
      (part) =>
        `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-${part.id}>\r\n\r\nHTTP/1.1 ${part.status} ${part.status === 200 ? "OK" : "Error"}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(part.body)}\r\n`
    )
    .join("")}--${boundary}--\r\n`;
  return new Response(text, {
    status: 200,
    headers: { "content-type": `multipart/mixed; boundary=${boundary}` }
  });
}

describe("Drive API client", () => {
  it("reads permissions for a page in one batch request and reports an unreadable ACL as null", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/batch/drive/v3")) {
          const body = String(init?.body);
          expect(init?.method).toBe("POST");
          expect(
            body.match(/GET \/drive\/v3\/files\/[^/]+\/permissions/g)
          ).toHaveLength(3);
          return batchResponse([
            {
              id: "p-a",
              status: 200,
              body: {
                permissions: [
                  {
                    id: "1",
                    type: "user",
                    emailAddress: "A@Example.com",
                    role: "reader"
                  }
                ]
              }
            },
            { id: "p-b", status: 403, body: { error: { code: 403 } } },
            {
              id: "p-c",
              status: 200,
              body: {
                permissions: [
                  {
                    id: "2",
                    type: "group",
                    emailAddress: "eng@example.com",
                    role: "commenter"
                  }
                ],
                nextPageToken: "more"
              }
            }
          ]);
        }
        // The rare continuation of a >100-permission file is read directly.
        expect(url).toContain("/files/c/permissions?");
        expect(url).toContain("pageToken=more");
        return Response.json({
          permissions: [{ id: "3", type: "anyone", role: "reader" }]
        });
      }
    );
    const client = createDriveApiClient("connector-token", {
      fetchImpl: fetchImpl as typeof fetch
    });
    const result = await client.listPermissions(["a", "b", "c", "a"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer connector-token"
      })
    });
    expect(result.get("b")).toBeNull();
    expect(normalizeGooglePermissions(result.get("a")!)).toEqual([
      {
        permissionId: "1",
        principalId: "a@example.com",
        principalKind: "user",
        role: "reader",
        inheritedFrom: undefined
      }
    ]);
    expect(normalizeGooglePermissions(result.get("c")!)).toEqual([
      {
        permissionId: "2",
        principalId: "eng@example.com",
        principalKind: "group",
        role: "reader",
        inheritedFrom: undefined
      },
      {
        permissionId: "3",
        principalId: "anyone",
        principalKind: "anyone",
        role: "reader",
        inheritedFrom: undefined
      }
    ]);
  });

  it("fails the whole batch on an unexpected part status rather than guessing", async () => {
    const fetchImpl = vi.fn(async () =>
      batchResponse([{ id: "f-x", status: 500, body: {} }])
    );
    const client = createDriveApiClient("token", {
      fetchImpl: fetchImpl as typeof fetch
    });
    await expect(client.getFiles(["x"])).rejects.toThrow(
      "files.get failed (500)"
    );
  });

  it("splits more than a hundred lookups into several batches and keeps unreadable targets null", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const ids = [
          ...String(init?.body).matchAll(/Content-ID: <f-([^>]+)>/g)
        ].map((match) => match[1]!);
        return batchResponse(
          ids.map((id) =>
            id === "missing"
              ? { id: `f-${id}`, status: 404, body: {} }
              : { id: `f-${id}`, status: 200, body: { id, name: id } }
          )
        );
      }
    );
    const client = createDriveApiClient("token", {
      fetchImpl: fetchImpl as typeof fetch
    });
    const ids = [
      ...Array.from({ length: 150 }, (_, index) => `file-${index}`),
      "missing"
    ];
    const files = await client.getFiles(ids);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(files.size).toBe(151);
    expect(files.get("missing")).toBeNull();
    expect(files.get("file-149")).toMatchObject({ id: "file-149" });
  });

  it("scopes change and file listings to the enrolled shared drive", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/changes/startPageToken"))
        return Response.json({ startPageToken: "7" });
      if (url.pathname.endsWith("/changes")) {
        expect(url.searchParams.get("driveId")).toBe("shared");
        expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
        expect(url.searchParams.get("includeRemoved")).toBe("true");
        return Response.json({ newStartPageToken: "8", changes: [] });
      }
      expect(url.searchParams.get("corpora")).toBe("drive");
      expect(url.searchParams.get("q")).toBe(
        "'root' in parents and trashed = false"
      );
      return Response.json({ files: [] });
    });
    const client = createDriveApiClient("token", {
      fetchImpl: fetchImpl as typeof fetch
    });
    await expect(client.getStartPageToken("shared")).resolves.toBe("7");
    await expect(client.listChanges("7", "shared")).resolves.toEqual({
      newStartPageToken: "8",
      changes: []
    });
    await expect(
      client.listFiles({ driveId: "shared", parentId: "root" })
    ).resolves.toEqual({ files: [] });
  });

  it("maps a Drive file to a connector document, dropping shortcut details from ordinary files", () => {
    expect(
      googleFileToDocument(
        {
          id: "f",
          parents: ["p"],
          sha256Checksum: "s",
          version: "4",
          mimeType: "application/pdf",
          shortcutDetails: { targetId: "ignored" }
        },
        "drive",
        [{ type: "domain", domain: "example.com", role: "reader" }]
      )
    ).toEqual({
      id: "f",
      driveId: "drive",
      parentIds: ["p"],
      blobHash: "s",
      trashed: false,
      permissions: [
        {
          permissionId: undefined,
          principalId: "example.com",
          principalKind: "domain",
          role: "reader",
          inheritedFrom: undefined
        }
      ],
      aclEvaluated: true,
      name: undefined,
      mimeType: "application/pdf",
      revision: "4",
      shortcutTargetId: undefined
    });
    expect(googleFileToDocument({ id: "f" }, "drive", null)).toMatchObject({
      aclEvaluated: false,
      permissions: []
    });
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
    await expect(checkDriveFileAccess("", "file", fetchImpl)).resolves.toBe(
      false
    );
    await expect(
      checkDriveFileAccess(
        "delegated",
        "file",
        vi.fn().mockResolvedValue(new Response("", { status: 403 }))
      )
    ).resolves.toBe(false);
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
