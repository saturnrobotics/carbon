import { createHash } from "node:crypto";
import type { VerifiedWorkforceIdentity } from "@carbon/portal/identity.server";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { type DriveRouteDependencies, handleDriveRoute } from "./drive-routes";
import { createWorkerHandler, type WorkerDependencies } from "./server";

type TestDependencies = DriveRouteDependencies & {
  statements: string[];
  fetchImpl: ReturnType<typeof vi.fn>;
};

type Responder = (
  text: string,
  values?: unknown[]
) => { rows: unknown[]; rowCount?: number };

/** A recording pool: statements are captured, answers come from the responder. */
function fakePool(respond: Responder) {
  const statements: string[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      statements.push(text.replace(/\s+/g, " ").trim());
      if (
        /^(BEGIN|COMMIT|ROLLBACK)/.test(text) ||
        text.startsWith("SELECT set_config")
      )
        return { rows: [], rowCount: 0 };
      const result = respond(text, values);
      return { rowCount: result.rows.length, ...result };
    },
    release() {
      /* Nothing to return to a recording pool. */
    }
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    statements
  };
}

const identity: VerifiedWorkforceIdentity = {
  principal: {
    kind: "human",
    actorId: "alice",
    companyId: "company-a",
    callerId: "query",
    sourceIdentity: {
      issuer: "https://cloud.google.com/iap",
      subject: "subject-a"
    },
    policyVersion: "1",
    capabilities: ["portal.read"]
  },
  companyGroupId: "company-a",
  allowedOperations: ["portal.read"],
  accessLevels: [],
  assurance: { mode: "carbon-mfa" }
};

function dependencies(
  overrides: Partial<DriveRouteDependencies> & {
    visible?: boolean;
    item?: { fileId: string; shortcutTargetId: string | null } | null;
    channelMatches?: boolean;
    admin?: boolean;
  }
): TestDependencies {
  const read = fakePool((text) =>
    text.includes("FROM portal.document d JOIN portal.source")
      ? { rows: overrides.visible ? [{}] : [] }
      : text.includes('FROM portal."driveEnrollment" e')
        ? { rows: [] }
        : { rows: [] }
  );
  const ingest = fakePool((text) =>
    text.includes('FROM portal."driveItem"')
      ? { rows: overrides.item ? [overrides.item] : [] }
      : text.includes('FROM portal."driveEnrollment"')
        ? { rows: overrides.channelMatches ? [{}] : [] }
        : { rows: [] }
  );
  const review = fakePool((text) =>
    text.includes("UPDATE portal.source")
      ? { rows: overrides.admin ? [{}] : [] }
      : { rows: [] }
  );
  const fetchImpl = vi.fn(async (input: string | URL | Request) =>
    Response.json({
      id: new URL(String(input)).pathname.split("/").at(-1),
      trashed: false,
      capabilities: { canDownload: true }
    })
  );
  return {
    readPool: read.pool,
    reviewPool: review.pool,
    ingestPool: ingest.pool,
    machineConfiguration: {
      audience: "machine",
      callers: [
        {
          subject: "sync",
          callerId: "drive-sync",
          companyIds: ["company-a"],
          sourceIds: ["source-drive"],
          capabilities: ["source.changes.read"]
        }
      ]
    },
    verifyHuman: vi.fn().mockResolvedValue(identity),
    userDriveAccessToken: vi.fn().mockResolvedValue("delegated-token"),
    requestDriveSync: vi.fn().mockResolvedValue(undefined),
    fetchImpl,
    statements: ingest.statements,
    ...overrides
  } as TestDependencies;
}

const access = (sourceId = "source-drive", fileId = "file-1") =>
  new Request(
    `https://worker.example.com/v1/drive/${sourceId}/documents/${fileId}/access`,
    { method: "POST" }
  );

describe("Drive live access route", () => {
  it("returns 404 when the reader's own row policy does not show the document", async () => {
    const deps = dependencies({
      visible: false,
      item: { fileId: "file-1", shortcutTargetId: null }
    });
    const response = await handleDriveRoute(
      access(),
      new URL(access().url),
      deps
    );
    expect(response?.status).toBe(404);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.verifyHuman).toHaveBeenCalledWith(
      expect.any(Request),
      "portal.read"
    );
  });

  it("denies without a delegated token, without a ledger entry, and for a source this worker does not sync", async () => {
    const noToken = dependencies({
      visible: true,
      item: { fileId: "file-1", shortcutTargetId: null },
      userDriveAccessToken: vi.fn().mockResolvedValue(null)
    });
    expect(
      (await handleDriveRoute(access(), new URL(access().url), noToken))?.status
    ).toBe(403);
    expect(noToken.fetchImpl).not.toHaveBeenCalled();

    const noItem = dependencies({ visible: true, item: null });
    expect(
      (await handleDriveRoute(access(), new URL(access().url), noItem))?.status
    ).toBe(403);

    const other = dependencies({
      visible: true,
      item: { fileId: "file-1", shortcutTargetId: null }
    });
    const request = access("unsynced-source");
    expect(
      (await handleDriveRoute(request, new URL(request.url), other))?.status
    ).toBe(403);
    expect(other.fetchImpl).not.toHaveBeenCalled();
  });

  it("checks the file and, for a shortcut, its target with the reader's token and answers 204 with no body", async () => {
    const deps = dependencies({
      visible: true,
      item: { fileId: "file-1", shortcutTargetId: "target-9" }
    });
    const response = await handleDriveRoute(
      access(),
      new URL(access().url),
      deps
    );
    expect(response?.status).toBe(204);
    expect(await response?.text()).toBe("");
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const urls = deps.fetchImpl.mock.calls.map((call) =>
      String((call as unknown[])[0])
    );
    expect(urls.some((url) => url.includes("/files/file-1?"))).toBe(true);
    expect(urls.some((url) => url.includes("/files/target-9?"))).toBe(true);
    for (const call of deps.fetchImpl.mock.calls)
      expect((call as unknown[])[1]).toMatchObject({
        headers: { Authorization: "Bearer delegated-token" }
      });
  });

  it("denies when Drive itself denies either the shortcut or its target", async () => {
    const deps = dependencies({
      visible: true,
      item: { fileId: "file-1", shortcutTargetId: "target-9" },
      fetchImpl: vi.fn(async (input: string | URL | Request) =>
        String(input).includes("target-9")
          ? new Response("", { status: 403 })
          : Response.json({
              id: "file-1",
              trashed: false,
              capabilities: { canDownload: true }
            })
      ) as unknown as typeof fetch
    });
    expect(
      (await handleDriveRoute(access(), new URL(access().url), deps))?.status
    ).toBe(403);
  });
});

describe("Drive notification hint route", () => {
  const notify = (headers: Record<string, string>, company = "company-a") =>
    new Request(
      `https://worker.example.com/v1/drive/source-drive/notifications?company=${company}`,
      {
        method: "POST",
        headers
      }
    );

  it("schedules a sync only for a channel whose id and token hash match the enrollment, and never reveals whether one exists", async () => {
    const token = "channel-secret";
    const matching = dependencies({ channelMatches: true });
    const request = notify({
      "x-goog-channel-id": "channel-1",
      "x-goog-channel-token": token,
      "x-goog-resource-state": "change"
    });
    const response = await handleDriveRoute(
      request,
      new URL(request.url),
      matching
    );
    expect(response?.status).toBe(204);
    expect(matching.requestDriveSync).toHaveBeenCalledWith({
      companyId: "company-a",
      sourceId: "source-drive",
      reason: "hint"
    });
    const hashed = matching.statements.find((statement) =>
      statement.includes('"notificationTokenHash"')
    );
    expect(hashed).toBeDefined();

    const mismatched = dependencies({ channelMatches: false });
    const bad = notify({
      "x-goog-channel-id": "channel-1",
      "x-goog-channel-token": "wrong",
      "x-goog-resource-state": "change"
    });
    expect(
      (await handleDriveRoute(bad, new URL(bad.url), mismatched))?.status
    ).toBe(204);
    expect(mismatched.requestDriveSync).not.toHaveBeenCalled();

    const sync = dependencies({ channelMatches: true });
    const initial = notify({
      "x-goog-channel-id": "channel-1",
      "x-goog-channel-token": token,
      "x-goog-resource-state": "sync"
    });
    expect(
      (await handleDriveRoute(initial, new URL(initial.url), sync))?.status
    ).toBe(204);
    expect(sync.requestDriveSync).not.toHaveBeenCalled();
    expect(createHash("sha256").update(token).digest("hex")).toHaveLength(64);
  });
});

describe("Drive source listing and sync request routes", () => {
  it("lists enrollments under the reader's own policy", async () => {
    const deps = dependencies({});
    const request = new Request("https://worker.example.com/v1/drive/sources");
    const response = await handleDriveRoute(
      request,
      new URL(request.url),
      deps
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ sources: [] });
  });

  it("lets only a source administrator request a sync", async () => {
    const admin = dependencies({ admin: true });
    const request = new Request(
      "https://worker.example.com/v1/drive/source-drive/sync",
      { method: "POST" }
    );
    expect(
      (await handleDriveRoute(request, new URL(request.url), admin))?.status
    ).toBe(202);
    expect(admin.requestDriveSync).toHaveBeenCalledWith({
      companyId: "company-a",
      sourceId: "source-drive",
      reason: "requested"
    });
    const reader = dependencies({ admin: false });
    expect(
      (await handleDriveRoute(request, new URL(request.url), reader))?.status
    ).toBe(403);
    expect(reader.requestDriveSync).not.toHaveBeenCalled();
  });

  it("is reached through the worker handler and leaves unrelated paths alone", async () => {
    const deps = dependencies({
      visible: true,
      item: { fileId: "file-1", shortcutTargetId: null }
    });
    const handler = createWorkerHandler({
      ...deps,
      bucket: "synthetic",
      automationUserId: "automation",
      manualSource: { sourceId: "manuals", displayName: "Manuals" },
      connectorAccessToken: async () => null
    } as unknown as WorkerDependencies);
    expect((await handler(access())).status).toBe(204);
    expect(
      (
        await handler(
          new Request("https://worker.example.com/v1/drive/unknown")
        )
      ).status
    ).toBe(404);
  });
});
