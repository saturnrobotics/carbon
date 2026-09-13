import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { AuthorizedCache } from "./cache/cache.server";
import { currentPolicySnapshot } from "./cache/epochs.server";
import type { CacheScope } from "./cache/keys";
import { IAP_ISSUER } from "./enrollment.server";
import {
  type IdentityBinding,
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER,
  type TrustedCallerConfiguration,
  type VerifiedTokenClaims,
  verifyWorkforceRequest
} from "./identity.server";

/**
 * The revocation contract between Carbon and the knowledge runtime, driven
 * through the real modules with test doubles for PostgreSQL and Google:
 * every path that revokes a binding (user deactivation trigger, membership
 * removal trigger, unbind function) leaves `active=false` and advances
 * `revocationVersion`; the epoch snapshot and the assertion check both read
 * that state on the next request.
 */

const now = 2_000_000_000;
const receiverAudience = "https://carbon-api.example.com";
const sourceAudience =
  "/projects/123456789/locations/us-central1/services/knowledge-web";
const subject = "accounts.google.com:100000000000000000098";

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

/** One binding row, mutated exactly as the trigger and the unbind function do. */
function bindingTable() {
  const row = {
    id: "kidn-synthetic",
    active: true,
    revocationVersion: 1,
    userActive: true,
    membershipActive: true
  };
  function revoke() {
    row.active = false;
    row.revocationVersion += 1;
  }
  const client = {
    async query(text: string) {
      if (text.includes('knowledge."identityBinding"'))
        return {
          rows: row.active
            ? [{ id: row.id, revocationVersion: String(row.revocationVersion) }]
            : []
        };
      if (text.includes("knowledge.source"))
        return {
          rows: [{ id: "source-a", contentEpoch: "1", aclEpoch: "1" }]
        };
      throw new Error(`unexpected query: ${text}`);
    }
  } as unknown as PoolClient;
  const identityStore = {
    async resolveHuman(): Promise<IdentityBinding> {
      return {
        actorId: "alice",
        companyId: "company-a",
        companyGroupId: "company-a",
        bindingActive: row.active,
        userActive: row.userActive,
        membershipActive: row.membershipActive,
        revocationVersion: row.revocationVersion,
        permissionsVersion: "1:permissions",
        capabilities: ["knowledge.read"]
      };
    }
  };
  return {
    row,
    client,
    identityStore,
    /** public.knowledge_propagate_identity_revocation on UPDATE OF active. */
    deactivateUser() {
      row.userActive = false;
      revoke();
    },
    /** public.knowledge_propagate_identity_revocation on DELETE of membership. */
    removeMembership() {
      row.membershipActive = false;
      revoke();
    },
    /** knowledge.unbind_workforce_identity (the identity:revoke script). */
    unbind: revoke
  };
}

function request() {
  return new Request(
    "https://carbon-api.example.com/api/v1/knowledge/getItemIdentity",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer service-token",
        [PORTAL_USER_EVIDENCE_HEADER]: "iap-token",
        [PORTAL_COMPANY_HEADER]: "company-a"
      }
    }
  );
}

function verify(
  identityStore: ReturnType<typeof bindingTable>["identityStore"]
) {
  return verifyWorkforceRequest({
    request: request(),
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

describe("identity revocation propagation", () => {
  it("folds the binding's revocation version into the policy snapshot and denies once no binding is active", async () => {
    const table = bindingTable();
    expect(await currentPolicySnapshot(table.client, ["source-a"])).toEqual({
      allowed: true,
      policyVersion: "kidn-synthetic:1",
      epochs: { "source-a:content": "1", "source-a:acl": "1" }
    });
    table.deactivateUser();
    expect(await currentPolicySnapshot(table.client, ["source-a"])).toEqual({
      allowed: false,
      policyVersion: "denied",
      epochs: {}
    });
  });

  it("refuses a warmed answer cache before delivery once the deactivation trigger has fired", async () => {
    const table = bindingTable();
    const values = new Map<string, unknown>();
    let reads = 0;
    let computed = 0;
    const cache = new AuthorizedCache(
      {
        get: async (key) => {
          reads += 1;
          return values.get(key);
        },
        set: async (key, value) => {
          values.set(key, value);
        }
      },
      () => currentPolicySnapshot(table.client, ["source-a"]),
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
    const readsWhileWarm = reads;
    expect(values.size).toBe(1);

    table.deactivateUser();
    await expect(get()).rejects.toThrow("Access denied");
    // Denied on the policy read alone: no cache lookup, no recompute.
    expect(reads).toBe(readsWhileWarm);
    expect(computed).toBe(1);
  });

  it.each([
    [
      "user deactivation",
      (table: ReturnType<typeof bindingTable>) => table.deactivateUser()
    ],
    [
      "membership removal",
      (table: ReturnType<typeof bindingTable>) => table.removeMembership()
    ],
    [
      "identity:revoke",
      (table: ReturnType<typeof bindingTable>) => table.unbind()
    ]
  ])("refuses a still-valid assertion after %s and changes the policy version", async (_path, revoke) => {
    const table = bindingTable();
    const before = await verify(table.identityStore);
    expect(before.principal.actorId).toBe("alice");
    expect(before.principal.policyVersion).toBe("identity-1:1:permissions");

    revoke(table);
    await expect(verify(table.identityStore)).rejects.toThrow(
      /unauthorized workforce request/i
    );
    expect(table.row.revocationVersion).toBe(2);
    expect(table.row.active).toBe(false);
  });
});
