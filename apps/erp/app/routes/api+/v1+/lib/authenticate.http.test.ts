// Error semantics of the v1 transport's two authentication branches, driven through
// the real route action and the real authenticate.server.ts. The workforce branch
// runs the real authorizeCarbonWorkforceRequest → verifyWorkforceRequest chain; only
// the token verifier is replaced (injected through verifyWorkforceRequest's own
// option), so a forged token fails the way a bad signature does in production,
// without a network round trip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePermissions: vi.fn(),
  getCompanyIdFromAPIKey: vi.fn(),
  getCarbonServiceRole: vi.fn(),
  getUserScopedClient: vi.fn(),
  getFreshUserClaims: vi.fn(),
  userHasVerifiedTotpFactor: vi.fn(),
  verifyServiceToken: vi.fn(),
  verifyIapToken: vi.fn(),
  resolveItems: vi.fn()
}));

vi.mock("~/modules/account/account.service", () => ({}));
vi.mock("~/modules/accounting/accounting.ee.service", () => ({}));
vi.mock("~/modules/documents/documents.service", () => ({}));
vi.mock("~/modules/inventory/inventory.service", () => ({}));
vi.mock("~/modules/invoicing/invoicing.service", () => ({}));
vi.mock("~/modules/items/items.service", () => ({}));
vi.mock("~/modules/knowledge/knowledge.service", () => ({
  resolveItems: mocks.resolveItems
}));
vi.mock("~/modules/people/people.service", () => ({}));
vi.mock("~/modules/production/production.mcp.server", () => ({}));
vi.mock("~/modules/production/production.service", () => ({}));
vi.mock("~/modules/purchasing/purchasing.service", () => ({}));
vi.mock("~/modules/quality/quality.service", () => ({}));
vi.mock("~/modules/resources/resources.service", () => ({}));
vi.mock("~/modules/sales/sales.service", () => ({}));
vi.mock("~/modules/settings/settings.service", () => ({}));
vi.mock("~/modules/shared/shared.service", () => ({}));
vi.mock("~/modules/users/users.service", () => ({}));
vi.mock("~/services/database.server", () => ({
  getDatabaseClient: () => ({})
}));

vi.mock("@carbon/auth/auth.server", () => ({
  requirePermissions: mocks.requirePermissions,
  getCompanyIdFromAPIKey: mocks.getCompanyIdFromAPIKey
}));
vi.mock("@carbon/auth/client.server", () => ({
  getCarbonServiceRole: mocks.getCarbonServiceRole,
  getUserScopedClient: mocks.getUserScopedClient
}));
vi.mock("@carbon/auth/users.server", () => ({
  getFreshUserClaims: mocks.getFreshUserClaims
}));
// The assurance step (Task 03) reads the actor's factor state through Redis and
// the service-role client; it runs only after a verified identity, which no case
// here reaches. Replaced at the same boundary as the other infrastructure — and
// its Supabase barrel reaches the Lingui macros vitest cannot compile anyway.
vi.mock("@carbon/auth/mfa.server", () => ({
  userHasVerifiedTotpFactor: mocks.userHasVerifiedTotpFactor
}));
vi.mock("@carbon/knowledge/identity.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@carbon/knowledge/identity.server")>();
  return {
    ...actual,
    verifyWorkforceRequest: (
      options: Parameters<typeof actual.verifyWorkforceRequest>[0]
    ) =>
      actual.verifyWorkforceRequest({
        tokenVerifier: {
          verifyServiceToken: mocks.verifyServiceToken,
          verifyIapToken: mocks.verifyIapToken
        },
        ...options
      })
  };
});

import { action } from "../$";

const URL = "https://erp.example.com/api/v1/knowledge/resolveItems";
const REGISTRY = JSON.stringify({
  version: 1,
  receiver: { id: "carbon-erp", audience: "https://erp.example.com" },
  callers: [
    {
      callerId: "knowledge-query",
      serviceAccountSubject: "synthetic-service-account-subject",
      sourceIapAudience: "/projects/0/global/backendServices/0",
      operations: ["knowledge_resolveItems"],
      capabilities: ["knowledge.read"],
      requiredAccessLevels: []
    }
  ]
});

function post(headers: Record<string, string>) {
  return action({
    request: new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ search: "SYN-100", limit: 5 })
    }),
    params: {},
    context: {}
  } as never);
}

async function thrown(promise: Promise<unknown>): Promise<Response> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("expected the action to throw a Response");
}

const workforceHeaders = {
  authorization: "Bearer forged.service.token",
  "x-portal-user-evidence": "forged.iap.assertion",
  "x-portal-company-id": "cmp_synthetic"
};

describe("v1 authentication error semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCarbonServiceRole.mockReturnValue({ rpc: vi.fn() });
    mocks.verifyServiceToken.mockRejectedValue(new Error("invalid signature"));
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("workforce branch", () => {
    it("answers 503 without a trusted-caller registry and never verifies anything", async () => {
      vi.stubEnv("KNOWLEDGE_TRUSTED_CALLERS_JSON", undefined);

      const response = await thrown(post(workforceHeaders));

      expect(response.status).toBe(503);
      expect(await response.text()).toBe(
        "Workforce authentication is not configured"
      );
      expect(mocks.verifyServiceToken).not.toHaveBeenCalled();
      expect(mocks.requirePermissions).not.toHaveBeenCalled();
      expect(mocks.resolveItems).not.toHaveBeenCalled();
    });

    it("answers a generic 401 for a forged token once a registry is configured", async () => {
      vi.stubEnv("KNOWLEDGE_TRUSTED_CALLERS_JSON", REGISTRY);

      const response = await thrown(post(workforceHeaders));

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(mocks.verifyServiceToken).toHaveBeenCalledWith(
        "forged.service.token",
        "https://erp.example.com"
      );
      expect(mocks.verifyIapToken).not.toHaveBeenCalled();
      expect(mocks.getUserScopedClient).not.toHaveBeenCalled();
      expect(mocks.resolveItems).not.toHaveBeenCalled();
    });

    it("answers the same 401 for a spoofed identity header, before any verification", async () => {
      vi.stubEnv("KNOWLEDGE_TRUSTED_CALLERS_JSON", REGISTRY);

      const response = await thrown(
        post({ ...workforceHeaders, "x-portal-actor-id": "usr_victim" })
      );

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(mocks.verifyServiceToken).not.toHaveBeenCalled();
    });

    it("is the branch taken by any non-API-key bearer, even without portal evidence", async () => {
      vi.stubEnv("KNOWLEDGE_TRUSTED_CALLERS_JSON", undefined);

      const response = await thrown(
        post({ authorization: "Bearer not-an-api-key" })
      );

      expect(response.status).toBe(503);
      expect(mocks.requirePermissions).not.toHaveBeenCalled();
    });
  });

  describe("API-key branch", () => {
    it("still rejects a missing key with its own 401 text", async () => {
      const response = await thrown(post({}));

      expect(response.status).toBe(401);
      expect(await response.text()).toBe(
        "Unauthorized: send your API key as `Authorization: Bearer crbn_…`."
      );
      expect(mocks.requirePermissions).not.toHaveBeenCalled();
    });

    it("still presents a crbn_ bearer to requirePermissions as carbon-key", async () => {
      mocks.requirePermissions.mockResolvedValue({
        client: {},
        companyId: "cmp_synthetic",
        companyGroupId: "grp_synthetic",
        userId: "usr_synthetic"
      });
      mocks.getCompanyIdFromAPIKey.mockResolvedValue({
        data: { scopes: { parts_view: ["cmp_synthetic"] } }
      });

      const response = await post({
        authorization: "Bearer crbn_synthetic_key"
      });

      const presented = mocks.requirePermissions.mock.calls[0][0] as Request;
      expect(presented.headers.get("carbon-key")).toBe("crbn_synthetic_key");
      expect(mocks.requirePermissions).toHaveBeenCalledWith(
        expect.any(Request),
        {}
      );
      // Knowledge operations stay invisible to API keys: the gate answers 404.
      expect(response.status).toBe(404);
      expect(mocks.resolveItems).not.toHaveBeenCalled();
    });

    it("still propagates requirePermissions' own failure Response untouched", async () => {
      mocks.requirePermissions.mockRejectedValue(
        new Response("Invalid API key", { status: 401 })
      );

      const response = await thrown(
        post({ authorization: "Bearer crbn_revoked" })
      );

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Invalid API key");
    });
  });
});
