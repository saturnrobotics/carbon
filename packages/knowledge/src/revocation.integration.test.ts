import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizedCache } from "./cache/cache.server";
import { currentPolicySnapshot } from "./cache/epochs.server";
import type { CacheScope } from "./cache/keys";
import {
  enrollWorkforceIdentity,
  IAP_ISSUER,
  unbindWorkforceIdentity
} from "./enrollment.server";
import {
  type IdentityBinding,
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER,
  type TrustedCallerConfiguration,
  type VerifiedTokenClaims,
  verifyWorkforceRequest,
  type WorkforceIdentityStore
} from "./identity.server";
import { getDisposableLocalDatabaseUrl } from "./test/database";

// Reserved synthetic IAP subject; every case rolls back.
const subject = "accounts.google.com:100000000000000000952";
const now = 2_000_000_000;
const receiverAudience = "https://carbon-api.example.com";
const sourceAudience =
  "/projects/123456789/locations/us-central1/services/knowledge-web";

const configuration: TrustedCallerConfiguration = {
  version: 1,
  receiver: { id: "carbon-read", audience: receiverAudience },
  callers: [
    {
      callerId: "knowledge-query",
      serviceAccountSubject: "100000000000000000001",
      sourceIapAudience: sourceAudience,
      operations: ["knowledge_getItemIdentity"],
      capabilities: ["knowledge.read"],
      requiredAccessLevels: []
    }
  ]
};
const serviceClaims: VerifiedTokenClaims = {
  iss: "https://accounts.google.com",
  sub: "100000000000000000001",
  aud: receiverAudience,
  iat: now - 30,
  exp: now + 300
};
const iapClaims: VerifiedTokenClaims = {
  iss: IAP_ISSUER,
  sub: subject,
  aud: sourceAudience,
  iat: now - 30,
  exp: now + 300
};
const scope: CacheScope = {
  companyId: "company-a",
  actorId: "alice",
  callerId: "knowledge-query",
  capability: "knowledge.read",
  intent: "locate",
  entities: ["motor-A"],
  query: "NEMA-34",
  locale: "en",
  businessTimezone: "America/New_York",
  modelVersion: "none",
  promptVersion: "1",
  indexVersion: "1"
};

describe("identity revocation through the real triggers", () => {
  it("deactivating a user or removing a membership revokes bindings for every database role", () => {
    expect(() =>
      execFileSync(
        "python3",
        [resolve(import.meta.dirname, "../scripts/test_revocation.py")],
        { stdio: "pipe" }
      )
    ).not.toThrow();
  });
});

describe("warmed answer cache and valid assertion on disposable PostgreSQL", () => {
  const pool = new pg.Pool({
    connectionString: getDisposableLocalDatabaseUrl(),
    max: 1,
    connectionTimeoutMillis: 5_000
  });
  let client: pg.PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client?.release();
    await pool.end();
  });

  /** cache/epochs.server.ts as the query service reads it: the read role with the transaction-local identity. */
  async function policy() {
    await client.query("SET LOCAL ROLE knowledge_read");
    try {
      return await currentPolicySnapshot(client, ["source-a"]);
    } finally {
      await client.query("RESET ROLE");
    }
  }

  const identityStore: WorkforceIdentityStore = {
    async resolveHuman(identity) {
      const result = await client.query<{ binding: IdentityBinding | null }>(
        "SELECT public.knowledge_resolve_workforce_identity($1::text,$2::text,$3::text) AS binding",
        [identity.issuer, identity.subject, identity.companyId]
      );
      return result.rows[0]?.binding ?? null;
    }
  };

  function verify() {
    return verifyWorkforceRequest({
      request: new Request(
        "https://carbon-api.example.com/api/v1/knowledge/getItemIdentity",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer service-token",
            [PORTAL_USER_EVIDENCE_HEADER]: "iap-token",
            [PORTAL_COMPANY_HEADER]: "company-a"
          }
        }
      ),
      operation: "knowledge_getItemIdentity",
      configuration,
      tokenVerifier: {
        verifyServiceToken: async () => serviceClaims,
        verifyIapToken: async () => iapClaims
      },
      identityStore,
      nowEpochSeconds: now
    });
  }

  it("is refused before delivery once the binding is revoked by the script or by the deactivation trigger", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT set_config('knowledge.actor_id','alice',true), set_config('knowledge.company_id','company-a',true)"
      );
      const enrolled = await enrollWorkforceIdentity(client, {
        subject,
        companyId: "company-a",
        userId: "alice",
        capabilities: ["knowledge.read"]
      });

      const warm = await policy();
      expect(warm.allowed).toBe(true);
      expect(warm.policyVersion).toBe(`id-alice:1|${enrolled.id}:1`);

      const values = new Map<string, unknown>();
      let computed = 0;
      const cache = new AuthorizedCache(
        {
          get: async (key) => values.get(key),
          set: async (key, value) => {
            values.set(key, value);
          }
        },
        policy,
        () => 1000
      );
      const get = () =>
        cache.get(
          scope,
          async () => ({ value: ++computed, evidenceIds: ["doc-a"] }),
          Number,
          async () => true
        );
      expect(await get()).toBe(1);
      expect(await get()).toBe(1);
      expect(computed).toBe(1);

      const admitted = await verify();
      expect(admitted.principal.actorId).toBe("alice");
      expect(admitted.principal.policyVersion.startsWith("identity-1:")).toBe(
        true
      );

      // identity:revoke path: the subject is refused; the user's other binding
      // keeps the actor admitted, but under a new policy version, so the warm
      // envelope is never delivered again.
      const unbound = await unbindWorkforceIdentity(client, {
        subject,
        companyId: "company-a"
      });
      expect(unbound.revocationVersion).toBe(2);
      await expect(verify()).rejects.toThrow(/unauthorized workforce request/i);
      const afterUnbind = await policy();
      expect(afterUnbind).toMatchObject({
        allowed: true,
        policyVersion: "id-alice:1"
      });
      expect(await get()).toBe(2);
      expect(computed).toBe(2);

      // Deactivation trigger path, fired by a non-superuser caller with no
      // EXECUTE grant on the trigger function: every binding is revoked and the
      // next delivery is refused on the policy read alone.
      await client.query("SELECT public.knowledge_fixture_mutator()");
      expect(await policy()).toEqual({
        allowed: false,
        policyVersion: "denied",
        epochs: {}
      });
      await expect(get()).rejects.toThrow("Access denied");
      expect(computed).toBe(2);
      await expect(verify()).rejects.toThrow(/unauthorized workforce request/i);
      const resolved = await identityStore.resolveHuman({
        issuer: IAP_ISSUER,
        subject,
        companyId: "company-a"
      });
      expect(resolved).toMatchObject({
        bindingActive: false,
        userActive: false,
        revocationVersion: 3
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
