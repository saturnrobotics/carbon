/**
 * Synthetic trusted-caller fixture whose verifier enforces audiences, so audience
 * and replay attacks are decided by the production verification path rather than
 * by a permissive stub.
 */
import type {
  IdentityBinding,
  TrustedCallerConfiguration,
  TrustedTokenVerifier,
  VerifiedTokenClaims
} from "../identity.server";

export const now = 2_000_000_000;
export const queryAudience = "https://query.example.test";
export const workerAudience = "https://worker.example.test";
export const portalIapAudience =
  "/projects/000000000000/global/backendServices/portal";
export const otherIapAudience =
  "/projects/000000000000/global/backendServices/other";

export const configuration: TrustedCallerConfiguration = {
  version: 1,
  receiver: { id: "query", audience: queryAudience },
  callers: [
    {
      callerId: "portal",
      serviceAccountSubject: "100000000000000000001",
      sourceIapAudience: portalIapAudience,
      operations: ["knowledge.query"],
      capabilities: ["knowledge.read"],
      requiredAccessLevels: []
    },
    {
      callerId: "other-portal",
      serviceAccountSubject: "100000000000000000002",
      sourceIapAudience: otherIapAudience,
      operations: ["knowledge.query"],
      capabilities: ["knowledge.read"],
      requiredAccessLevels: []
    }
  ]
};

export const binding: IdentityBinding = {
  actorId: "usr_alex",
  companyId: "cmp_alpha",
  companyGroupId: "group_alpha",
  bindingActive: true,
  userActive: true,
  membershipActive: true,
  revocationVersion: 1,
  permissionsVersion: "permissions-1",
  capabilities: ["knowledge.read"]
};

/** Tokens are opaque labels; the verifier returns claims only for the audience they were minted for. */
export const tokens: Record<string, VerifiedTokenClaims> = {
  "service:query": {
    iss: "https://accounts.google.com",
    sub: "100000000000000000001",
    aud: queryAudience,
    iat: now - 30,
    exp: now + 300
  },
  "service:worker": {
    iss: "https://accounts.google.com",
    sub: "100000000000000000001",
    aud: workerAudience,
    iat: now - 30,
    exp: now + 300
  },
  "service:other-portal": {
    iss: "https://accounts.google.com",
    sub: "100000000000000000002",
    aud: queryAudience,
    iat: now - 30,
    exp: now + 300
  },
  "iap:portal:alex": {
    iss: "https://cloud.google.com/iap",
    sub: "accounts.google.com:alex",
    aud: portalIapAudience,
    iat: now - 30,
    exp: now + 300
  },
  "iap:other:alex": {
    iss: "https://cloud.google.com/iap",
    sub: "accounts.google.com:alex",
    aud: otherIapAudience,
    iat: now - 30,
    exp: now + 300
  }
};

function hasAudience(actual: string | string[] | undefined, expected: string) {
  return Array.isArray(actual)
    ? actual.includes(expected)
    : actual === expected;
}

export const verifier: TrustedTokenVerifier = {
  async verifyServiceToken(token, expectedAudience) {
    const claims = tokens[token];
    return claims && hasAudience(claims.aud, expectedAudience) ? claims : {};
  },
  async verifyIapToken(token, expectedAudience) {
    const claims = tokens[token];
    return claims && hasAudience(claims.aud, expectedAudience) ? claims : {};
  }
};

export function workforceRequest(
  serviceToken: string,
  userEvidence: string,
  companyId = "cmp_alpha"
) {
  return new Request("https://query.example.test/v1/query", {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "x-portal-user-evidence": userEvidence,
      "x-portal-company-id": companyId
    }
  });
}
