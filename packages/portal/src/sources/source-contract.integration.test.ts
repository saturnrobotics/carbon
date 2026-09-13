import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPortalTransaction } from "../database.server";
import { claimOutbox } from "../indexing/outbox.server";
import { getDisposableLocalDatabaseUrl } from "../test/database";
import {
  getCarbonSweepState,
  persistCarbonChangePage,
  planCarbonChanges,
  projectCarbonItem,
  reconcileCarbonRange
} from "./carbon.server";
import type { SourceChange } from "./contract";

/**
 * The Carbon projection against the real portal schema, through the real
 * `portal_ingest` role and row policies: replayed and reordered deliveries
 * converge, tombstones reach the outbox with priority, an idle sweep moves no
 * epoch, and a sweep page tombstones only what Carbon stopped listing inside
 * its own range.
 */
const connectionString = getDisposableLocalDatabaseUrl();
const adminUrl = new URL(connectionString);
adminUrl.username = "supabase_admin";
const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
const ingest = new pg.Pool({
  connectionString: adminUrl.toString(),
  options: "-c role=portal_ingest",
  max: 2
});

const sourceId = `source-carbon-${randomUUID().slice(0, 8)}`;
const indexer = { companyId: "company-a", callerId: "indexer-a", sourceId };
const automationUserId = "alice";
const at = (second: number) =>
  `2026-09-01T10:00:${String(second).padStart(2, "0")}Z`;
const motor = (id: string, version: string) =>
  projectCarbonItem(
    {
      id,
      readableId: `MTR-${id}`,
      name: `Motor ${id}`,
      revision: "B",
      mpn: `M-${id}`,
      description: null
    },
    version
  );
const change = (
  id: string,
  version: string,
  second: number,
  entity: SourceChange["entity"]
): SourceChange => ({
  id: `kso-${id}-${version}-${second}`,
  entityType: "item",
  entityId: id,
  sourceVersion: version,
  eventType: entity ? "upsert" : "delete",
  observedAt: at(second),
  entity
});

async function epochs() {
  const result = await admin.query<{ contentEpoch: string; aclEpoch: string }>(
    `SELECT "contentEpoch","aclEpoch" FROM portal.source WHERE "companyId"=$1 AND id=$2`,
    [indexer.companyId, sourceId]
  );
  return result.rows[0]!;
}
async function entity(sourceEntityId: string) {
  const result = await admin.query<{
    sourceRevision: string;
    deletedAt: string | null;
    displayName: string;
    observedAt: string;
  }>(
    `SELECT "sourceRevision","deletedAt"::text AS "deletedAt","displayName","observedAt"::text AS "observedAt"
     FROM portal.entity WHERE "companyId"=$1 AND "sourceId"=$2 AND "entityType"='part' AND "sourceEntityId"=$3`,
    [indexer.companyId, sourceId, sourceEntityId]
  );
  return result.rows[0] ?? null;
}

beforeAll(async () => {
  await admin.query(
    `INSERT INTO portal.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
     VALUES ($1,'company-a','alice','carbon',$1,'Carbon (synthetic)','alice','internal','{"machineCallers":["indexer-a"],"ingestDatabaseRoles":["supabase_admin"]}')`,
    [sourceId]
  );
});
afterAll(async () => {
  await admin.query(
    `DELETE FROM portal.outbox WHERE "companyId"=$1 AND "sourceId"=$2`,
    [indexer.companyId, sourceId]
  );
  await admin.query(
    `DELETE FROM portal.entity WHERE "companyId"=$1 AND "sourceId"=$2`,
    [indexer.companyId, sourceId]
  );
  await admin.query(
    `DELETE FROM portal.source WHERE "companyId"=$1 AND id=$2`,
    [indexer.companyId, sourceId]
  );
  await ingest.end();
  await admin.end();
});

describe("Carbon source contract against the portal schema", () => {
  it("converges under replay and reordering, and only a visible change moves the content epoch", async () => {
    const before = await epochs();
    const first = await persistCarbonChangePage(ingest, indexer, {
      sourceId,
      automationUserId,
      plan: planCarbonChanges([change("m1", "v2", 9, motor("m1", "v2"))])
    });
    expect(first).toMatchObject({ upserted: 1, tombstoned: 0 });
    const afterFirst = await epochs();
    expect(Number(afterFirst.contentEpoch)).toBe(
      Number(before.contentEpoch) + 1
    );

    // An older observation of an older version arrives late: no write.
    const late = await persistCarbonChangePage(ingest, indexer, {
      sourceId,
      automationUserId,
      plan: planCarbonChanges([change("m1", "v1", 5, motor("m1", "v1"))])
    });
    expect(late.upserted).toBe(0);
    // The same delivery again: no write, no epoch movement.
    const replay = await persistCarbonChangePage(ingest, indexer, {
      sourceId,
      automationUserId,
      plan: planCarbonChanges([change("m1", "v2", 9, motor("m1", "v2"))])
    });
    expect(replay.upserted).toBe(0);
    expect((await epochs()).contentEpoch).toBe(afterFirst.contentEpoch);
    expect(await entity("m1")).toMatchObject({
      sourceRevision: "v2",
      deletedAt: null,
      displayName: "Motor m1"
    });
  });

  it("tombstones through the outbox with priority and lets a newer observation resurrect", async () => {
    await persistCarbonChangePage(ingest, indexer, {
      sourceId,
      automationUserId,
      plan: planCarbonChanges([change("m2", "v1", 1, motor("m2", "v1"))])
    });
    const gone = await persistCarbonChangePage(ingest, indexer, {
      sourceId,
      automationUserId,
      plan: planCarbonChanges([change("m2", "v1", 2, null)])
    });
    expect(gone).toMatchObject({ tombstoned: 1, invalidations: 1 });
    expect((await entity("m2"))?.deletedAt).not.toBeNull();
    // A stale, out-of-order upsert observed BEFORE the delete cannot resurrect.
    const stale = await persistCarbonChangePage(ingest, indexer, {
      sourceId,
      automationUserId,
      plan: planCarbonChanges([change("m2", "v1", 1, motor("m2", "v1"))])
    });
    expect(stale.upserted).toBe(0);
    expect((await entity("m2"))?.deletedAt).not.toBeNull();
    // Carbon showing the row again later does resurrect it.
    const back = await persistCarbonChangePage(ingest, indexer, {
      sourceId,
      automationUserId,
      plan: planCarbonChanges([change("m2", "v2", 3, motor("m2", "v2"))])
    });
    expect(back.upserted).toBe(1);
    expect((await entity("m2"))?.deletedAt).toBeNull();

    // The invalidation consumer sees the tombstone first and only through
    // its own partition; indexing delivery never leases it.
    const leased = await claimOutbox(ingest, indexer, "worker-t12", 100, [
      "delete",
      "acl-change"
    ]);
    const mine = leased.filter((event) => event.sourceId === sourceId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      entityType: "entity",
      eventType: "delete",
      payload: { sourceEntityType: "part", sourceEntityId: "m2" }
    });
    expect(
      (
        await claimOutbox(ingest, indexer, "worker-t12", 100, ["upsert"])
      ).filter((event) => event.sourceId === sourceId)
    ).toEqual([]);
  });

  it("sweeps a keyset range: matching versions write nothing, unlisted rows in range are tombstoned", async () => {
    await persistCarbonChangePage(ingest, indexer, {
      sourceId,
      automationUserId,
      plan: planCarbonChanges([
        change("s1", "v1", 1, motor("s1", "v1")),
        change("s2", "v1", 1, motor("s2", "v1")),
        change("s3", "v1", 1, motor("s3", "v1")),
        change("t9", "v1", 1, motor("t9", "v1"))
      ])
    });
    const state = await getCarbonSweepState(ingest, indexer, sourceId);
    expect(state).toEqual({ entityType: "item", afterId: null });
    const idle = await epochs();
    // Carbon lists s1 unchanged, s2 at a new version, and no longer lists s3
    // inside the range (null, "s3"]. t9 is outside the range and untouched.
    const page = await reconcileCarbonRange(ingest, indexer, {
      sourceId,
      automationUserId,
      entityType: "item",
      portalEntityType: "part",
      afterId: null,
      lastId: "s3",
      versions: [
        { entityId: "m1", sourceVersion: "v2" },
        { entityId: "m2", sourceVersion: "v2" },
        { entityId: "s1", sourceVersion: "v1" },
        { entityId: "s2", sourceVersion: "v2" }
      ],
      observedAt: at(30),
      expected: state,
      next: { entityType: "item", afterId: "s3" }
    });
    expect(page.stale).toEqual(["s2"]);
    expect(page.tombstoned).toBe(1);
    expect((await entity("s3"))?.deletedAt).not.toBeNull();
    expect((await entity("t9"))?.deletedAt).toBeNull();
    expect((await entity("s1"))?.sourceRevision).toBe("v1");
    // The tombstone is the only epoch movement; matched rows wrote nothing.
    expect(Number((await epochs()).contentEpoch)).toBe(
      Number(idle.contentEpoch) + 1
    );
    expect(await getCarbonSweepState(ingest, indexer, sourceId)).toEqual({
      entityType: "item",
      afterId: "s3"
    });
    // A stale cursor expectation is refused rather than applied twice.
    await expect(
      reconcileCarbonRange(ingest, indexer, {
        sourceId,
        automationUserId,
        entityType: "item",
        portalEntityType: "part",
        afterId: null,
        lastId: "s3",
        versions: [],
        observedAt: at(31),
        expected: state,
        next: { entityType: "item", afterId: "s3" }
      })
    ).rejects.toThrow("cursor changed");
  });

  it("refuses a human principal and an unregistered machine caller", async () => {
    await expect(
      persistCarbonChangePage(
        ingest,
        { ...indexer, actorId: "alice" },
        { sourceId, automationUserId, plan: planCarbonChanges([]) }
      )
    ).rejects.toThrow("machine principal");
    await expect(
      persistCarbonChangePage(
        ingest,
        { ...indexer, callerId: "someone-else" },
        {
          sourceId,
          automationUserId,
          plan: planCarbonChanges([change("x1", "v1", 1, motor("x1", "v1"))])
        }
      )
    ).rejects.toThrow();
    expect(
      await withPortalTransaction(
        admin,
        indexer,
        "read",
        async (client) =>
          (
            await client.query(
              `SELECT 1 FROM portal.entity WHERE "companyId"=$1 AND "sourceId"=$2 AND "sourceEntityId"='x1'`,
              [indexer.companyId, sourceId]
            )
          ).rows.length
      )
    ).toBe(0);
  });
});
