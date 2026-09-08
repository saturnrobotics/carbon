import { describe, expect, it } from "vitest";
import { handleIdentityRequest } from "./identity.server";

const binding = {
  actorId: "alice",
  companyId: "company-a",
  companyGroupId: "group-a",
  bindingActive: true,
  userActive: true,
  membershipActive: true,
  revocationVersion: 1,
  permissionsVersion: "2",
  capabilities: ["knowledge.read", "kanban.ticket.create"]
};
const configuration = {
  version: 1 as const,
  receiver: { id: "query", audience: "query-aud" },
  callers: [
    {
      callerId: "web",
      serviceAccountSubject: "sa-web",
      sourceIapAudience: "iap-web",
      operations: ["knowledge.identity"],
      capabilities: ["knowledge.read"],
      requiredAccessLevels: []
    }
  ]
};
const tokenVerifier = {
  verifyServiceToken: async () => ({
    iss: "https://accounts.google.com",
    sub: "sa-web",
    aud: "query-aud",
    iat: 900,
    exp: 1200
  }),
  verifyIapToken: async () => ({
    iss: "https://cloud.google.com/iap",
    sub: "google-alice",
    aud: "iap-web",
    iat: 900,
    exp: 1200
  })
};
const request = () =>
  new Request("https://query.example/v1/identity", {
    method: "POST",
    headers: {
      authorization: "Bearer service",
      "x-portal-user-evidence": "iap",
      "x-portal-company-id": "company-a"
    }
  });

describe("identity endpoint", () => {
  it("resolves only the cryptographically verified subject and bounds capabilities", async () => {
    const calls: unknown[] = [];
    const response = await handleIdentityRequest(request(), {
      configuration,
      tokenVerifier,
      nowEpochSeconds: 1000,
      identityStore: {
        resolveHuman: async (identity) => {
          calls.push(identity);
          return binding;
        }
      }
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        issuer: "https://cloud.google.com/iap",
        subject: "google-alice",
        companyId: "company-a"
      }
    ]);
    const body = await response.json();
    expect(body.binding.capabilities).toEqual(["knowledge.read"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("never touches the identity database before token verification", async () => {
    let calls = 0;
    const response = await handleIdentityRequest(request(), {
      configuration,
      tokenVerifier: {
        ...tokenVerifier,
        verifyServiceToken: async () => {
          throw Error("forged");
        }
      },
      identityStore: {
        resolveHuman: async () => {
          calls++;
          return binding;
        }
      }
    });
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });
  it("rejects revoked company membership", async () => {
    const response = await handleIdentityRequest(request(), {
      configuration,
      tokenVerifier,
      nowEpochSeconds: 1000,
      identityStore: {
        resolveHuman: async () => ({ ...binding, membershipActive: false })
      }
    });
    expect(response.status).toBe(401);
  });
});
