import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizedCache, type CacheStore } from "../cache/cache.server";
import { currentPolicySnapshot } from "../cache/epochs.server";
import { withPortalTransaction } from "../database.server";
import { parseStoredExtraction } from "../intake/contracts";
import { getDisposableLocalDatabaseUrl } from "../test/database";
import {
  type DriveChange,
  type DriveDocument,
  getDriveEnrollment,
  getDriveItemForAccess,
  listDriveDescendants,
  listDriveEnrollments,
  listDriveLedger,
  matchesDriveNotificationChannel,
  persistDriveChangePage,
  reconcileDriveListing,
  recordDriveSyncOutcome
} from "./drive.server";
import { publishDriveDocumentVersion } from "./drive-publication.server";

/**
 * Real non-owner row policies, real epoch triggers, real forced RLS. Two
 * Drive sources of one company hold the same PDF bytes with different ACLs;
 * a reader of one must never learn that the other exists.
 */
const connectionString = getDisposableLocalDatabaseUrl();
const adminUrl = new URL(connectionString);
adminUrl.username = "supabase_admin";
const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
const ingestPool = new pg.Pool({
  connectionString: adminUrl.toString(),
  options: "-c role=portal_ingest",
  max: 1
});
const readPool = new pg.Pool({
  connectionString,
  options: "-c role=portal_read",
  max: 2
});

const company = "company-a";
const sourceA = "t19-drive-a";
const sourceB = "t19-drive-b";
const automation = "automation";
const machine = (sourceId: string) => ({
  companyId: company,
  callerId: "indexer-a",
  sourceId
});
const alice = { companyId: company, actorId: "alice", callerId: "query" };
const carol = { companyId: company, actorId: "t19-carol", callerId: "query" };
const sharedPdf = "f".repeat(64);

function doc(
  id: string,
  parentIds: string[],
  users: string[],
  extra: Partial<DriveDocument> = {}
): DriveDocument {
  return {
    id,
    driveId: "drive-a",
    parentIds,
    blobHash: `hash-${id}`,
    trashed: false,
    permissions: users.map((email) => ({
      principalId: email,
      principalKind: "user" as const,
      role: "reader" as const
    })),
    name: `Document ${id}`,
    mimeType: "application/pdf",
    revision: "1",
    aclEvaluated: true,
    ...extra
  };
}
const folder = (id: string, parentIds: string[], users: string[]) =>
  doc(id, parentIds, users, {
    mimeType: "application/vnd.google-apps.folder",
    blobHash: ""
  });
const change = (
  kind: DriveChange["kind"],
  document: DriveDocument,
  cursor = "c"
): DriveChange => ({ cursor, kind, document });

async function persist(
  sourceId: string,
  expectedCursor: string,
  nextCursor: string,
  changes: DriveChange[]
) {
  return persistDriveChangePage(ingestPool, machine(sourceId), {
    sourceId,
    automationUserId: automation,
    expectedCursor,
    nextCursor,
    changes
  });
}

async function publish(
  sourceId: string,
  fileId: string,
  hash: string,
  revision = "1"
) {
  const document = await admin.query<{ id: string }>(
    `SELECT id FROM portal.document WHERE "companyId"=$1 AND "sourceId"=$2 AND "sourceItemId"=$3`,
    [company, sourceId, fileId]
  );
  return publishDriveDocumentVersion(ingestPool, machine(sourceId), {
    documentId: document.rows[0]!.id,
    sourceId,
    sourceRevision: revision,
    createdBy: automation,
    reference: {
      objectKey: `drive/${sourceId}/${fileId}`,
      generation: "1",
      sha256: hash,
      mimeType: "application/pdf",
      bytes: 3
    },
    extraction: parseStoredExtraction({
      fields: {},
      evidence: {
        body: [{ page: 1, text: `Torque specification ${fileId} t19` }]
      },
      unresolved: [],
      warnings: []
    }),
    parserVersion: "t19",
    indexGeneration: "1"
  });
}

async function visibleFiles(principal: typeof alice, sourceId: string) {
  return withPortalTransaction(readPool, principal, "read", async (client) =>
    (
      await client.query<{ sourceItemId: string }>(
        `SELECT d."sourceItemId" FROM portal.chunk c JOIN portal.document d ON d.id=c."documentId" AND d."companyId"=c."companyId"
         WHERE c."companyId"=$1 AND d."sourceId"=$2 ORDER BY 1`,
        [principal.companyId, sourceId]
      )
    ).rows.map((row) => row.sourceItemId)
  );
}

async function chunkIds(sourceId: string, fileIds: string[]) {
  const result = await admin.query<{ id: string }>(
    `SELECT c.id FROM portal.chunk c JOIN portal.document d ON d.id=c."documentId" AND d."companyId"=c."companyId"
     WHERE c."companyId"=$1 AND d."sourceId"=$2 AND d."sourceItemId"=ANY($3::text[]) ORDER BY 1`,
    [company, sourceId, fileIds]
  );
  return result.rows.map((row) => row.id);
}

/** The production re-read shape: chunk ids under the reader's row policy. */
async function authorizedChunks(principal: typeof alice, ids: string[]) {
  return withPortalTransaction(readPool, principal, "read", async (client) =>
    (
      await client.query<{ id: string }>(
        `SELECT c.id FROM portal.chunk c WHERE c."companyId"=$1 AND c.id=ANY($2::text[]) ORDER BY c.id`,
        [principal.companyId, ids]
      )
    ).rows.map((row) => row.id)
  );
}

async function outboxRows(sourceId: string) {
  const result = await admin.query<{
    sourceItemId: string;
    eventType: string;
    sourceVersion: string;
    deliveredAt: string | null;
  }>(
    `SELECT d."sourceItemId",o."eventType",o."sourceVersion",o."deliveredAt" FROM portal.outbox o
     JOIN portal.document d ON d.id=o."entityId" AND d."companyId"=o."companyId"
     WHERE o."companyId"=$1 AND o."sourceId"=$2 ORDER BY 1,2,3`,
    [company, sourceId]
  );
  return result.rows;
}

async function cleanup() {
  for (const sourceId of [sourceA, sourceB]) {
    await admin.query(
      `DELETE FROM portal.outbox WHERE "companyId"=$1 AND "sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `DELETE FROM portal."grant" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `UPDATE portal.document SET "currentVersionId"=NULL,version=version+1 WHERE "companyId"=$1 AND "sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `DELETE FROM portal.chunk c USING portal.document d WHERE c."documentId"=d.id AND c."companyId"=d."companyId" AND d."companyId"=$1 AND d."sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `DELETE FROM portal."documentVersion" v USING portal.document d WHERE v."documentId"=d.id AND v."companyId"=d."companyId" AND d."companyId"=$1 AND d."sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `DELETE FROM portal.document WHERE "companyId"=$1 AND "sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `DELETE FROM portal."driveItem" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `DELETE FROM portal."driveEnrollment" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `DELETE FROM portal."sourceUserBinding" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [company, sourceId]
    );
    await admin.query(
      `DELETE FROM portal.source WHERE "companyId"=$1 AND id=$2`,
      [company, sourceId]
    );
  }
  await admin.query(
    `DELETE FROM portal."identityBinding" WHERE "companyId"=$1 AND id='t19-carol-binding'`,
    [company]
  );
  await admin.query(
    `DELETE FROM public."userToCompany" WHERE "userId"='t19-carol'`
  );
  await admin.query(`DELETE FROM public."user" WHERE id='t19-carol'`);
}

describe("Drive connector over real row policies", () => {
  beforeAll(async () => {
    await cleanup();
    await admin.query(
      `INSERT INTO public."user"(id) VALUES ('t19-carol') ON CONFLICT DO NOTHING`
    );
    await admin.query(
      `INSERT INTO public."userToCompany" VALUES ('t19-carol',$1) ON CONFLICT DO NOTHING`,
      [company]
    );
    await admin.query(
      `INSERT INTO portal."identityBinding" (id,"companyId","createdBy",issuer,subject,"canonicalUserId",active,capabilities)
       VALUES ('t19-carol-binding',$1,'alice','https://identity.example.com','subject-t19-carol','t19-carol',true,ARRAY['portal.read'])`,
      [company]
    );
    for (const [sourceId, driveId] of [
      [sourceA, "drive-a"],
      [sourceB, "drive-b"]
    ] as const) {
      await admin.query(
        `INSERT INTO portal.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
         VALUES ($1,$2,'alice','drive',$1,$3,'alice','internal','{"machineCallers":["indexer-a"],"ingestDatabaseRoles":["supabase_admin"]}')`,
        [sourceId, company, `Drive ${driveId}`]
      );
      await admin.query(
        `INSERT INTO portal."driveEnrollment" ("companyId","createdBy","sourceId",corpora,"driveId","rootFolderIds","oauthScope","credentialSecretRef","notificationChannelId","notificationTokenHash")
         VALUES ($1,'alice',$2,'drive',$3,$4,'https://www.googleapis.com/auth/drive.readonly','projects/synthetic/secrets/drive-connector/versions/1','channel-'||$2,repeat('a',64))`,
        [company, sourceId, driveId, sourceId === sourceA ? ["root-a"] : []]
      );
      // Source-level local grants: the local ACL never broadens the source ACL.
      for (const user of ["alice", "t19-carol"])
        await admin.query(
          `INSERT INTO portal."grant"(id,"companyId","createdBy","sourceId","subjectKind","subjectId",capability,origin,"policyVersion")
           VALUES ($1,$2,'alice',$3,'user',$4,'read','local',1)`,
          [`t19-${sourceId}-${user}`, company, sourceId, user]
        );
    }
    // Shared-drive membership is recorded by the administrator at enrollment
    // as a source-scoped source grant: it is what lets a reader see the source
    // itself. Alice is an external collaborator on drive A (file grants only);
    // carol is a member of drive B.
    await admin.query(
      `INSERT INTO portal."grant"(id,"companyId","createdBy","sourceId","subjectKind","subjectId",capability,origin,"policyVersion")
       VALUES ($1,$2,'alice',$3,'user','t19-carol','read','source',1)`,
      [`t19-${sourceB}-member`, company, sourceB]
    );
    await admin.query(
      `INSERT INTO portal."sourceUserBinding"(id,"companyId","createdBy","sourceId","canonicalUserId","sourceUserId",active)
       VALUES ('t19-bind-a-alice',$1,'alice',$2,'alice','alice@example.com',true),
              ('t19-bind-b-carol',$1,'alice',$3,'t19-carol','carol@example.com',true)`,
      [company, sourceA, sourceB]
    );
  });
  afterAll(async () => {
    await cleanup();
    await Promise.all([admin.end(), ingestPool.end(), readPool.end()]);
  });

  it("refuses a human principal and reads a read-only enrollment", async () => {
    await expect(
      getDriveEnrollment(ingestPool, { ...alice }, sourceA)
    ).rejects.toThrow("machine principal");
    const enrollment = await getDriveEnrollment(
      ingestPool,
      machine(sourceA),
      sourceA
    );
    expect(enrollment).toMatchObject({
      corpora: "drive",
      driveId: "drive-a",
      rootFolderIds: ["root-a"],
      domainWideDelegation: false,
      cursor: ""
    });
    await expect(
      matchesDriveNotificationChannel(ingestPool, machine(sourceA), {
        sourceId: sourceA,
        channelId: `channel-${sourceA}`,
        tokenHash: "a".repeat(64)
      })
    ).resolves.toBe(true);
    await expect(
      matchesDriveNotificationChannel(ingestPool, machine(sourceA), {
        sourceId: sourceA,
        channelId: `channel-${sourceA}`,
        tokenHash: "b".repeat(64)
      })
    ).resolves.toBe(false);
  });

  it("persists a scoped listing once and converges on a repeated reconciliation without duplicates", async () => {
    const listing = [
      folder("root-a", [], ["alice@example.com"]),
      folder("team", ["root-a"], ["alice@example.com"]),
      doc("spec", ["team"], ["alice@example.com"]),
      doc("shared", ["root-a"], ["alice@example.com"], { blobHash: sharedPdf }),
      doc("outside", ["elsewhere"], ["alice@example.com"]),
      doc("unknown-acl", ["root-a"], [], { aclEvaluated: false }),
      doc("link", ["root-a"], ["alice@example.com"], {
        mimeType: "application/pdf",
        shortcutTargetId: "spec",
        blobHash: "hash-spec",
        revision: "1:1"
      })
    ];
    const first = await persist(
      sourceA,
      "",
      "",
      listing.map((document) => change("upsert", document))
    );
    expect(first.upserted).toBe(4);
    await persist(sourceA, "", "token-1", []);
    const enrollment = await getDriveEnrollment(
      ingestPool,
      machine(sourceA),
      sourceA
    );
    expect(enrollment.cursor).toBe("token-1");

    const documents = await admin.query<{
      sourceItemId: string;
      status: string;
    }>(
      `SELECT "sourceItemId",status FROM portal.document WHERE "companyId"=$1 AND "sourceId"=$2 ORDER BY 1`,
      [company, sourceA]
    );
    // Folders and out-of-scope items are ledger rows, never documents.
    expect(documents.rows.map((row) => row.sourceItemId)).toEqual([
      "link",
      "shared",
      "spec",
      "unknown-acl"
    ]);
    const grants = await admin.query<{
      sourceItemId: string;
      subjectId: string;
    }>(
      `SELECT d."sourceItemId",g."subjectId" FROM portal."grant" g JOIN portal.document d ON d.id=g."documentId" AND d."companyId"=g."companyId"
       WHERE g."companyId"=$1 AND g."sourceId"=$2 AND g.origin='source' AND g."revokedAt" IS NULL ORDER BY 1`,
      [company, sourceA]
    );
    // An unevaluated ACL receives no grant: excluded, not guessed.
    expect(grants.rows).toEqual([
      { sourceItemId: "link", subjectId: "alice" },
      { sourceItemId: "shared", subjectId: "alice" },
      { sourceItemId: "spec", subjectId: "alice" }
    ]);
    const outbox = await outboxRows(sourceA);
    expect(
      outbox.map((row) => [row.sourceItemId, row.eventType, row.sourceVersion])
    ).toEqual([
      ["link", "upsert", "1:1"],
      ["shared", "upsert", "1"],
      ["spec", "upsert", "1"],
      ["unknown-acl", "upsert", "1"]
    ]);
    const payload = await admin.query<{ payload: { driveFileId: string } }>(
      `SELECT o.payload FROM portal.outbox o JOIN portal.document d ON d.id=o."entityId" AND d."companyId"=o."companyId"
       WHERE o."companyId"=$1 AND d."sourceItemId"='link'`,
      [company]
    );
    expect(payload.rows[0]?.payload.driveFileId).toBe("spec");

    // A second full listing of an unchanged drive is a no-op.
    const ledger = await listDriveLedger(ingestPool, machine(sourceA), sourceA);
    const diff = reconcileDriveListing("token-1", listing, ledger);
    expect(diff).toEqual([]);
    await persist(sourceA, "token-1", "token-1", diff);
    const versions = await admin.query<{ version: string }>(
      `SELECT version FROM portal.document WHERE "companyId"=$1 AND "sourceId"=$2 AND "sourceItemId"='spec'`,
      [company, sourceA]
    );
    expect(versions.rows[0]?.version).toBe("1");
    expect(await outboxRows(sourceA)).toHaveLength(4);
  });

  it("makes a document readable only after publication and only for the bound reader", async () => {
    await publish(sourceA, "spec", "hash-spec");
    await publish(sourceA, "shared", sharedPdf);
    await publish(sourceA, "link", "hash-spec", "1:1");
    expect(await visibleFiles(alice, sourceA)).toEqual([
      "link",
      "shared",
      "spec"
    ]);
    expect(await visibleFiles(carol, sourceA)).toEqual([]);
    await expect(
      getDriveItemForAccess(ingestPool, machine(sourceA), sourceA, "link")
    ).resolves.toEqual({ fileId: "link", shortcutTargetId: "spec" });
    await expect(
      getDriveItemForAccess(
        ingestPool,
        machine(sourceA),
        sourceA,
        "unknown-acl"
      )
    ).resolves.toBeNull();
    await expect(
      getDriveItemForAccess(ingestPool, machine(sourceA), sourceA, "outside")
    ).resolves.toBeNull();
  });

  it("keeps the same PDF in two drives on separate ACLs and never reveals the hidden source", async () => {
    await persist(sourceB, "", "token-b", [
      change("upsert", {
        ...doc("shared-b", [], ["carol@example.com"], { blobHash: sharedPdf }),
        driveId: "drive-b"
      })
    ]);
    await publish(sourceB, "shared-b", sharedPdf);
    expect(await visibleFiles(carol, sourceB)).toEqual(["shared-b"]);
    expect(await visibleFiles(alice, sourceB)).toEqual([]);
    expect(await visibleFiles(carol, sourceA)).toEqual([]);
    const enrollmentsForCarol = await listDriveEnrollments(readPool, carol);
    expect(enrollmentsForCarol.map((entry) => entry.sourceId)).toEqual([
      sourceB
    ]);
    expect(enrollmentsForCarol[0]).toMatchObject({
      displayName: "Drive drive-b",
      ownerId: "alice",
      corpora: "drive",
      rootFolderIds: [],
      domainWideDelegation: false,
      documentCount: 1
    });
    // A collaborator with file grants alone never learns a source exists.
    expect(await listDriveEnrollments(readPool, alice)).toEqual([]);
    const byHash = await admin.query<{ count: string }>(
      `SELECT count(DISTINCT "documentId")::text AS count FROM portal."documentVersion" WHERE "companyId"=$1 AND "contentHash"=$2`,
      [company, sharedPdf]
    );
    expect(byHash.rows[0]?.count).toBe("2");
  });

  it("invalidates every descendant, a warm answer and a candidate batch after a parent folder permission change", async () => {
    const descendants = await listDriveDescendants(
      ingestPool,
      machine(sourceA),
      sourceA,
      ["team"]
    );
    expect(descendants).toEqual(["link", "spec"]);

    const specChunks = await chunkIds(sourceA, ["spec", "link"]);
    const store = new Map<string, unknown>();
    const cacheStore: CacheStore = {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
      }
    };
    let computed = 0;
    const cache = new AuthorizedCache(cacheStore, () =>
      withPortalTransaction(readPool, alice, "read", (client) =>
        currentPolicySnapshot(client, [sourceA])
      )
    );
    const scope = {
      companyId: company,
      actorId: "alice",
      callerId: "query",
      capability: "portal.read",
      intent: "locate",
      entities: [sourceA],
      query: "torque specification",
      locale: "en",
      businessTimezone: "UTC",
      modelVersion: "locate-no-model",
      promptVersion: "t19",
      indexVersion: "lexical-v1"
    };
    const read = () =>
      cache.get(
        scope,
        async () => {
          computed += 1;
          const ids = await authorizedChunks(alice, specChunks);
          return { value: ids, evidenceIds: ids };
        },
        (value) => value as string[],
        async (ids) =>
          (await authorizedChunks(alice, ids)).length === ids.length
      );
    expect(await read()).toEqual(specChunks);
    expect(await read()).toEqual(specChunks);
    expect(computed).toBe(1);
    const before = await admin.query<{ aclEpoch: string }>(
      `SELECT "aclEpoch" FROM portal.source WHERE "companyId"=$1 AND id=$2`,
      [company, sourceA]
    );

    // The folder loses alice; the connector re-reads each descendant's ACL.
    await persist(sourceA, "token-1", "token-2", [
      change("permission", folder("team", ["root-a"], [])),
      change("permission", doc("spec", ["team"], [])),
      change("permission", {
        ...doc("link", ["root-a"], [], {
          shortcutTargetId: "spec",
          blobHash: "hash-spec",
          revision: "1:1"
        })
      })
    ]);
    const after = await admin.query<{ aclEpoch: string }>(
      `SELECT "aclEpoch" FROM portal.source WHERE "companyId"=$1 AND id=$2`,
      [company, sourceA]
    );
    expect(Number(after.rows[0]?.aclEpoch)).toBeGreaterThan(
      Number(before.rows[0]?.aclEpoch)
    );
    const events = (await outboxRows(sourceA)).filter(
      (row) => row.eventType === "acl-change"
    );
    expect(events.map((row) => row.sourceItemId).sort()).toEqual([
      "link",
      "spec"
    ]);
    // Cached answer: the policy snapshot moved, the recompute finds nothing.
    expect(await read()).toEqual([]);
    expect(computed).toBe(2);
    // Candidate batch: the re-read under the reader's policy comes back short,
    // which is exactly the condition that refuses provider disclosure.
    expect(await authorizedChunks(alice, specChunks)).toEqual([]);
    expect(await visibleFiles(alice, sourceA)).toEqual(["shared"]);
  });

  it("withdraws deleted, moved-out and inaccessible-shortcut items and re-arms a delivered outbox event", async () => {
    await admin.query(
      `UPDATE portal.outbox SET "deliveredAt"=now(),version=version+1 WHERE "companyId"=$1 AND "sourceId"=$2`,
      [company, sourceA]
    );
    await persist(sourceA, "token-2", "token-3", [
      change("delete", { ...doc("spec", ["team"], []), trashed: true }),
      change(
        "move",
        doc("shared", ["elsewhere"], ["alice@example.com"], {
          blobHash: sharedPdf
        })
      ),
      change("delete", {
        ...doc("link", ["root-a"], [], { shortcutTargetId: "spec" }),
        trashed: true
      })
    ]);
    const documents = await admin.query<{
      sourceItemId: string;
      status: string;
    }>(
      `SELECT "sourceItemId",status FROM portal.document WHERE "companyId"=$1 AND "sourceId"=$2 ORDER BY 1`,
      [company, sourceA]
    );
    expect(documents.rows).toEqual([
      { sourceItemId: "link", status: "withdrawn" },
      { sourceItemId: "shared", status: "withdrawn" },
      { sourceItemId: "spec", status: "withdrawn" },
      { sourceItemId: "unknown-acl", status: "draft" }
    ]);
    expect(await visibleFiles(alice, sourceA)).toEqual([]);
    const pending = (await outboxRows(sourceA)).filter(
      (row) => row.deliveredAt === null
    );
    expect(pending.map((row) => [row.sourceItemId, row.eventType])).toEqual([
      ["link", "delete"],
      ["shared", "delete"],
      ["spec", "delete"]
    ]);
    // Moving back into scope re-arms the already delivered upsert instead of
    // creating a second row for the same identity.
    await persist(sourceA, "token-3", "token-4", [
      change(
        "move",
        doc("shared", ["root-a"], ["alice@example.com"], {
          blobHash: sharedPdf
        })
      )
    ]);
    const shared = (await outboxRows(sourceA)).filter(
      (row) => row.sourceItemId === "shared" && row.eventType === "upsert"
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]?.deliveredAt).toBeNull();
  });

  it("changes nothing when a page fails and records the outcome without broadening access", async () => {
    const before = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM portal."grant" WHERE "companyId"=$1 AND "sourceId"=$2 AND "revokedAt" IS NULL`,
      [company, sourceA]
    );
    await expect(
      persist(sourceA, "stale-cursor", "token-5", [
        change(
          "upsert",
          doc("spec", ["team"], ["alice@example.com", "carol@example.com"])
        )
      ])
    ).rejects.toThrow("cursor changed");
    const after = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM portal."grant" WHERE "companyId"=$1 AND "sourceId"=$2 AND "revokedAt" IS NULL`,
      [company, sourceA]
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    // The revived "shared" document is the only readable one, before and after.
    expect(await visibleFiles(alice, sourceA)).toEqual(["shared"]);
    await recordDriveSyncOutcome(ingestPool, machine(sourceA), {
      sourceId: sourceA,
      automationUserId: automation,
      status: "failed",
      error: "Drive cursor changed"
    });
    const enrollment = await getDriveEnrollment(
      ingestPool,
      machine(sourceA),
      sourceA
    );
    expect(enrollment.lastSyncStatus).toBe("failed");
    expect(enrollment.cursor).toBe("token-4");
  });
});
