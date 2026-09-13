import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPortalTransaction } from "../database.server";
import { acknowledgeOutbox, claimOutbox } from "../indexing/outbox.server";
import { lexicalSearch } from "../retrieval/lexical.server";
import { getDisposableLocalDatabaseUrl } from "../test/database";
import { AuthorizedCache, type CacheStore } from "./cache.server";
import {
  bumpSourceEpochs,
  currentPolicySnapshot,
  INVALIDATION_EVENT_TYPES,
  planInvalidation
} from "./epochs.server";
import { type CacheScope, cacheKey } from "./keys";
import { createRedisCache } from "./redis.server";

/**
 * Real Redis, real non-owner PostgreSQL row policies, real epoch triggers.
 * Nothing here mocks the policy read or the store; every scenario is the
 * production composition with one dependency removed or one row changed.
 */
const connectionString = getDisposableLocalDatabaseUrl();
const redisUrl = process.env.PORTAL_TEST_REDIS_URL;
if (!redisUrl)
  throw new Error("Revocation proof requires PORTAL_TEST_REDIS_URL");
const adminUrl = new URL(connectionString);
adminUrl.username = "supabase_admin";

const readPool = new pg.Pool({
  connectionString,
  options: "-c role=portal_read",
  max: 2
});
const ingestPool = new pg.Pool({
  connectionString: adminUrl.toString(),
  options: "-c role=portal_ingest",
  max: 1
});
const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
const redis = createRedisCache(redisUrl);

const alice = { companyId: "company-a", actorId: "alice", callerId: "query" };
const indexer = {
  companyId: "company-a",
  callerId: "indexer-a",
  sourceId: "source-a"
};
const sourceIds = ["source-a"];

/** Each scenario owns its keys: the store is shared and keys are deterministic. */
function scopeFor(
  actorId: string,
  query: string,
  salt: string,
  companyId = "company-a"
) {
  return {
    companyId,
    actorId,
    callerId: "query",
    capability: "portal.read",
    intent: "locate",
    entities: [...sourceIds],
    query,
    locale: "en",
    businessTimezone: "UTC",
    modelVersion: "locate-no-model",
    promptVersion: `query-v1:${salt}`,
    indexVersion: "lexical-v1"
  } satisfies CacheScope;
}

function policyFor(pool: pg.Pool, principal: typeof alice) {
  return () =>
    withPortalTransaction(pool, principal, "read", (client) =>
      currentPolicySnapshot(client, sourceIds)
    );
}

/** The production authorizer shape: chunk ids are re-read under RLS on delivery. */
function authorizerFor(principal: typeof alice) {
  return async (ids: readonly string[]) => {
    if (!ids.length) return true;
    const rows = await withPortalTransaction(
      readPool,
      principal,
      "read",
      async (client) =>
        (
          await client.query<{ id: string }>(
            `SELECT c.id FROM portal.chunk c WHERE c."companyId"=$1 AND c.id=ANY($2::text[])`,
            [principal.companyId, ids]
          )
        ).rows
    );
    return rows.length === new Set(ids).size;
  };
}

function harness(
  store: CacheStore,
  principal: typeof alice,
  query: string,
  policy = policyFor(readPool, principal)
) {
  let computed = 0;
  const salt = randomUUID();
  const cache = new AuthorizedCache(store, policy);
  const scope = scopeFor(principal.actorId, query, salt, principal.companyId);
  const get = () =>
    cache.get(
      scope,
      async () => {
        computed += 1;
        const rows = await withPortalTransaction(
          readPool,
          principal,
          "read",
          (client) =>
            lexicalSearch(client, principal.companyId, sourceIds, query)
        );
        const ids = rows.map((row) => row.id);
        return { value: ids, evidenceIds: ids };
      },
      (value) => {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
          throw new Error("Invalid cache data");
        return value as string[];
      },
      authorizerFor(principal)
    );
  return {
    get,
    scope,
    get computed() {
      return computed;
    }
  };
}

async function sourceEpochs() {
  const result = await admin.query<{ contentEpoch: string; aclEpoch: string }>(
    `SELECT "contentEpoch","aclEpoch" FROM portal.source WHERE id='source-a' AND "companyId"='company-a'`
  );
  return result.rows[0]!;
}

describe("versioned cache revocation over real Redis and PostgreSQL", () => {
  beforeAll(async () => {
    const binding = await admin.query(
      `SELECT active FROM portal."identityBinding" WHERE id='id-alice' AND "companyId"='company-a'`
    );
    expect(binding.rows).toEqual([{ active: true }]);
  });
  afterAll(async () => {
    await Promise.all([redis.close(), readPool.end(), ingestPool.end()]);
    await admin.end();
  });

  it("serves a warm Redis hit only until the actor's binding is revoked", async () => {
    const h = harness(redis.store, alice, "manual");
    expect(await h.get()).toEqual(["chunk-doc-a"]);
    expect(await h.get()).toEqual(["chunk-doc-a"]);
    expect(h.computed).toBe(1);
    await admin.query(
      `UPDATE portal."identityBinding" SET active=false,version=version+1 WHERE id='id-alice' AND "companyId"='company-a'`
    );
    try {
      await expect(h.get()).rejects.toThrow("Access denied");
      expect(h.computed).toBe(1);
    } finally {
      await admin.query(
        `UPDATE portal."identityBinding" SET active=true,version=version+1 WHERE id='id-alice' AND "companyId"='company-a'`
      );
    }
    expect(await h.get()).toEqual(["chunk-doc-a"]);
  });

  it("a newly matching document invalidates a previously empty result set", async () => {
    const token = `orbital${randomUUID().replace(/-/g, "")}`;
    const documentId = `doc-t17-${token}`;
    const h = harness(redis.store, alice, token);
    expect(await h.get()).toEqual([]);
    expect(await h.get()).toEqual([]);
    expect(h.computed).toBe(1);
    const before = await sourceEpochs();
    try {
      await admin.query(
        `INSERT INTO portal.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification)
         VALUES ($1,'company-a','alice','source-a',$1,$2,'alice','manual','published','internal')`,
        [documentId, `${token} manual`]
      );
      await admin.query(
        `INSERT INTO portal."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus")
         VALUES ('version-'||$1,'company-a','alice',$1,'revision-1',$1,'synthetic/t17.pdf','1','application/pdf',100,now(),'parser-1','ready')`,
        [documentId]
      );
      await admin.query(
        `UPDATE portal.document SET "currentVersionId"='version-'||id,version=version+1 WHERE id=$1 AND "companyId"='company-a'`,
        [documentId]
      );
      await admin.query(
        `INSERT INTO portal."grant"(id,"companyId","createdBy","sourceId","documentId","subjectKind","subjectId",capability,origin,"policyVersion")
         VALUES ('grant-local-'||$1,'company-a','alice','source-a',$1,'user','alice','read','local',1),
                ('grant-source-'||$1,'company-a','alice','source-a',$1,'user','alice','read','source',1)`,
        [documentId]
      );
      await admin.query(
        `INSERT INTO portal.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount","embeddingProfile","indexGeneration")
         VALUES ('chunk-'||$1,'company-a','alice',$1,'version-'||$1,0,$2,3,'synthetic-768',1)`,
        [documentId, `${token} manual`]
      );
      const after = await sourceEpochs();
      expect(Number(after.contentEpoch)).toBeGreaterThan(
        Number(before.contentEpoch)
      );
      expect(await h.get()).toEqual([`chunk-${documentId}`]);
      expect(h.computed).toBe(2);
    } finally {
      await admin.query(
        `DELETE FROM portal.chunk WHERE "companyId"='company-a' AND "documentId"=$1`,
        [documentId]
      );
      await admin.query(
        `DELETE FROM portal."grant" WHERE "companyId"='company-a' AND "documentId"=$1`,
        [documentId]
      );
      await admin.query(
        `UPDATE portal.document SET "currentVersionId"=NULL,version=version+1 WHERE id=$1 AND "companyId"='company-a'`,
        [documentId]
      );
      await admin.query(
        `DELETE FROM portal."documentVersion" WHERE "companyId"='company-a' AND "documentId"=$1`,
        [documentId]
      );
      await admin.query(
        `DELETE FROM portal.document WHERE "companyId"='company-a' AND id=$1`,
        [documentId]
      );
    }
    // The tombstone is itself an epoch bump: the warm "found" answer is gone too.
    expect(await h.get()).toEqual([]);
    expect(h.computed).toBe(3);
  });

  it("applies reordered and duplicated outbox invalidations to the same end state", async () => {
    const version = `t17-${randomUUID()}`;
    const h = harness(redis.store, alice, "manual");
    expect(await h.get()).toEqual(["chunk-doc-a"]);
    const warmKey = cacheKey(h.scope, await policyFor(readPool, alice)());
    expect(await redis.store.get(warmKey)).toBeDefined();
    const before = await sourceEpochs();
    // Delivered out of order relative to their source versions, with a duplicate
    // of the revocation, plus a Kanban board change and a new index generation.
    const events = [
      ["correction", `${version}-3`],
      ["acl-change", `${version}-1`],
      ["delete", `${version}-2`],
      ["board-change", `${version}-4`],
      ["index-version", `${version}-5`],
      ["acl-change", `${version}-1`]
    ] as const;
    await admin.query(
      `INSERT INTO portal.outbox("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
       SELECT 'company-a','alice','source-a','document','doc-a',e."sourceVersion",e."eventType",'{}'
       FROM jsonb_to_recordset($1::jsonb) AS e("eventType" text,"sourceVersion" text)
       ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO NOTHING`,
      [
        JSON.stringify(
          events.map(([eventType, sourceVersion]) => ({
            eventType,
            sourceVersion
          }))
        )
      ]
    );
    const workerId = `revocation-${randomUUID()}`;
    const claimed = await claimOutbox(
      ingestPool,
      indexer,
      workerId,
      100,
      INVALIDATION_EVENT_TYPES
    );
    const mine = claimed.filter((event) =>
      event.sourceVersion.startsWith(version)
    );
    expect(mine.map((event) => event.eventType).sort()).toEqual([
      "acl-change",
      "board-change",
      "correction",
      "delete",
      "index-version"
    ]);
    // Revocations and tombstones are leased ahead of the other invalidation kinds.
    expect(["acl-change", "delete"]).toContain(mine[0]!.eventType);
    expect(["acl-change", "delete"]).toContain(mine[1]!.eventType);
    const plan = planInvalidation(mine);
    expect(plan).toEqual(planInvalidation([...mine].reverse()));
    expect(plan).toEqual(planInvalidation([...mine, ...mine]));
    await withPortalTransaction(ingestPool, indexer, "write", (client) =>
      bumpSourceEpochs(client, "company-a", plan)
    );
    await acknowledgeOutbox(
      ingestPool,
      indexer,
      workerId,
      claimed.map((event) => event.id)
    );
    const after = await sourceEpochs();
    expect(Number(after.aclEpoch)).toBe(Number(before.aclEpoch) + 1);
    expect(Number(after.contentEpoch)).toBe(Number(before.contentEpoch) + 1);
    // Nothing is left for a second consumer, and the warm key no longer applies.
    expect(
      (
        await claimOutbox(
          ingestPool,
          indexer,
          workerId,
          100,
          INVALIDATION_EVENT_TYPES
        )
      ).filter((event) => event.sourceVersion.startsWith(version))
    ).toEqual([]);
    expect(cacheKey(h.scope, await policyFor(readPool, alice)())).not.toBe(
      warmKey
    );
    expect(await h.get()).toEqual(["chunk-doc-a"]);
    expect(h.computed).toBe(2);
  });

  it("Redis loss degrades to an authoritative read instead of a failure", async () => {
    const lossy = createRedisCache(redisUrl);
    const h = harness(lossy.store, alice, "manual");
    expect(await h.get()).toEqual(["chunk-doc-a"]);
    expect(await h.get()).toEqual(["chunk-doc-a"]);
    expect(h.computed).toBe(1);
    await lossy.close();
    expect(await h.get()).toEqual(["chunk-doc-a"]);
    expect(h.computed).toBe(2);
  });

  it("policy-store loss denies delivery even with a warm Redis envelope", async () => {
    const policyPool = new pg.Pool({
      connectionString,
      options: "-c role=portal_read",
      max: 1
    });
    const h = harness(
      redis.store,
      alice,
      "manual",
      policyFor(policyPool, alice)
    );
    expect(await h.get()).toEqual(["chunk-doc-a"]);
    const warmKey = cacheKey(h.scope, await policyFor(readPool, alice)());
    expect(await redis.store.get(warmKey)).toBeDefined();
    await policyPool.end();
    await expect(h.get()).rejects.toThrow();
    expect(h.computed).toBe(1);
  });

  it("another user cannot read a warm result through the same query", async () => {
    const reads: string[] = [];
    const spying: CacheStore = {
      get: async (key) => {
        reads.push(key);
        return redis.store.get(key);
      },
      set: (key, value, ttl) => redis.store.set(key, value, ttl)
    };
    const owner = harness(spying, alice, "manual");
    expect(await owner.get()).toEqual(["chunk-doc-a"]);
    const ownerKey = reads.at(-1)!;
    expect(await redis.store.get(ownerKey)).toBeDefined();
    for (const actorId of ["bob", "revoked", "nobody"]) {
      const attacker = harness(spying, { ...alice, actorId }, "manual");
      await expect(attacker.get()).rejects.toThrow("Access denied");
      expect(attacker.computed).toBe(0);
    }
    // Denied actors never derive the owner's key, so Redis never saw a lookup for it.
    expect(reads.filter((key) => key === ownerKey)).toHaveLength(1);
    expect(
      cacheKey(
        { ...owner.scope, actorId: "bob" },
        await policyFor(readPool, alice)()
      )
    ).not.toBe(ownerKey);
  });
});
