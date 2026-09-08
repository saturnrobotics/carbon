import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyWorkforceRequest = vi.fn();
const getUserScopedClient = vi.fn();
const getFreshUserClaims = vi.fn();

vi.mock("@carbon/knowledge/identity.server", () => ({
  verifyWorkforceRequest
}));
vi.mock("../lib/supabase/client.server", () => ({ getUserScopedClient }));
vi.mock("./users.server", () => ({ getFreshUserClaims }));

describe("authorizeWorkforceRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the canonical actor for a user-scoped client and current permissions", async () => {
    const identity = {
      principal: {
        kind: "human",
        actorId: "usr_existing",
        companyId: "cmp_alpha",
        callerId: "knowledge-query",
        sourceIdentity: { issuer: "iap", subject: "immutable-subject" },
        policyVersion: "identity-3:permissions-5",
        capabilities: ["source.entity.read"]
      },
      companyGroupId: "grp_alpha",
      allowedOperations: ["knowledge_getItemIdentity"],
      accessLevels: ["managed-device"]
    };
    const client = { from: vi.fn() };
    const claims = {
      role: "employee",
      permissions: {
        parts: { view: ["cmp_alpha"], create: [], update: [], delete: [] }
      }
    };
    verifyWorkforceRequest.mockResolvedValue(identity);
    getUserScopedClient.mockResolvedValue(client);
    getFreshUserClaims.mockResolvedValue(claims);

    const { authorizeWorkforceRequest } = await import("./workforce.server");
    const result = await authorizeWorkforceRequest({
      request: new Request("https://api.example.com"),
      operation: "knowledge_getItemIdentity",
      configuration: {} as never,
      identityStore: {} as never
    });

    expect(getUserScopedClient).toHaveBeenCalledWith("usr_existing");
    expect(getFreshUserClaims).toHaveBeenCalledWith(
      "usr_existing",
      "cmp_alpha"
    );
    expect(result).toMatchObject({ client, ...claims });
    expect(result.principal).toEqual(identity.principal);
  });

  it("does not mint a client when identity verification fails", async () => {
    verifyWorkforceRequest.mockRejectedValue(new Error("unauthorized"));
    const { authorizeWorkforceRequest } = await import("./workforce.server");

    await expect(
      authorizeWorkforceRequest({
        request: new Request("https://api.example.com"),
        operation: "knowledge_getItemIdentity",
        configuration: {} as never,
        identityStore: {} as never
      })
    ).rejects.toThrow("unauthorized");
    expect(getUserScopedClient).not.toHaveBeenCalled();
  });
});
