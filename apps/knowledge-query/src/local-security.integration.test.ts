import { randomUUID } from "node:crypto";
import { createRedisCache } from "@carbon/knowledge/cache/redis.server";
import { postgresIdentityStore } from "@carbon/knowledge/identity-store.server";
import { getDisposableLocalDatabaseUrl } from "@carbon/knowledge/test/database";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createReadHandler } from "./query.server";

it("real Redis hits cannot survive canonical user or document grant revocation", async () => {
  const connectionString = getDisposableLocalDatabaseUrl();
  const adminUrl = new URL(connectionString);
  adminUrl.username = "supabase_admin";
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const pool = new Pool({
    connectionString,
    options: "-c role=knowledge_read",
    max: 2
  });
  const redisUrl = process.env.KNOWLEDGE_TEST_REDIS_URL;
  if (!redisUrl)
    throw new Error("Local security proof requires KNOWLEDGE_TEST_REDIS_URL");
  const cache = createRedisCache(redisUrl);
  const id = `local-security-${randomUUID()}`;
  let hits = 0;
  let stores = 0;
  const originalUser = await admin.query(
    'SELECT active FROM public."user" WHERE id=$1',
    ["bob"]
  );
  const originalGrant = await admin.query(
    'SELECT "revokedAt" FROM knowledge."grant" WHERE id=$1 AND "companyId"=$2',
    ["grant-b-local", "company-b"]
  );
  expect(originalUser.rows).toHaveLength(1);
  expect(originalGrant.rows).toHaveLength(1);
  try {
    await admin.query(
      `INSERT INTO knowledge."identityBinding" (id,"companyId","createdBy",issuer,subject,"canonicalUserId",active,capabilities) VALUES ($1,'company-b','bob','https://cloud.google.com/iap',$1,'bob',true,ARRAY['knowledge.read'])`,
      [id]
    );
    const handler = createReadHandler({
      pool,
      manualSourceId: "source-b",
      identityStore: postgresIdentityStore(pool),
      configuration: {
        version: 1,
        receiver: { id, audience: id },
        callers: [
          {
            callerId: id,
            serviceAccountSubject: id,
            sourceIapAudience: id,
            operations: ["knowledge.query"],
            capabilities: ["knowledge.read"],
            requiredAccessLevels: []
          }
        ]
      },
      tokenVerifier: {
        verifyServiceToken: async () => ({
          iss: "https://accounts.google.com",
          sub: id,
          aud: id,
          iat: 900,
          exp: 1200
        }),
        verifyIapToken: async () => ({
          iss: "https://cloud.google.com/iap",
          sub: id,
          aud: id,
          iat: 900,
          exp: 1200
        })
      },
      nowEpochSeconds: 1000,
      origin: "https://portal.example",
      businessTimezone: "UTC",
      cacheStore: {
        async get(key) {
          const value = await cache.store.get(key);
          if (value !== undefined) hits++;
          return value;
        },
        async set(key, value, ttl) {
          await cache.store.set(key, value, ttl);
          stores++;
        }
      }
    });
    const query = (companyId = "company-b") =>
      handler(
        new Request("https://query.example/v1/query", {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic",
            "x-portal-user-evidence": "synthetic",
            "x-portal-company-id": companyId,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            requestId: randomUUID(),
            text: "manual",
            mode: "locate",
            locale: "en"
          })
        })
      );
    const initial = await query();
    expect(initial.status).toBe(200);
    expect(
      (await initial.json()).evidence.some(
        (row: { id: string }) => row.id === "chunk-doc-b"
      )
    ).toBe(true);
    expect(stores).toBeGreaterThan(0);
    expect((await query()).status).toBe(200);
    expect(hits).toBeGreaterThan(0);
    // The query handler maps verifier failures to its generic
    // fail-closed response; assert that contract, not merely non-200.
    const wrongCompany = await query("company-a");
    expect(wrongCompany.status).toBe(503);
    expect(await wrongCompany.json()).toEqual({ error: "query_unavailable" });

    await admin.query('UPDATE public."user" SET active=false WHERE id=$1', [
      "bob"
    ]);
    const inactive = await query();
    expect(inactive.status).toBe(503);
    expect(await inactive.text()).not.toContain("chunk-doc-b");
    await admin.query('UPDATE public."user" SET active=$1 WHERE id=$2', [
      originalUser.rows[0].active,
      "bob"
    ]);
    expect((await query()).status).toBe(200);

    await admin.query(
      'UPDATE knowledge."grant" SET "revokedAt"=now(),version=version+1 WHERE id=$1 AND "companyId"=$2',
      ["grant-b-local", "company-b"]
    );
    const revoked = await query();
    expect([200, 403]).toContain(revoked.status);
    expect(await revoked.text()).not.toContain("chunk-doc-b");
  } finally {
    await admin.query('UPDATE public."user" SET active=$1 WHERE id=$2', [
      originalUser.rows[0].active,
      "bob"
    ]);
    await admin.query(
      'UPDATE knowledge."grant" SET "revokedAt"=$1,version=version+1 WHERE id=$2 AND "companyId"=$3',
      [originalGrant.rows[0].revokedAt, "grant-b-local", "company-b"]
    );
    await admin.query(
      'DELETE FROM knowledge."identityBinding" WHERE id=$1 AND "companyId"=$2',
      [id, "company-b"]
    );
    await Promise.all([cache.close(), pool.end(), admin.end()]);
  }
});
