import { describe, expect, it, vi } from "vitest";
import type {
  IdentityBinding,
  TrustedCallerConfiguration,
  TrustedTokenVerifier,
  VerifiedTokenClaims
} from "./identity.server";
import {
  createServiceAuthorizationHeader,
  createWorkforceForwardingHeaders,
  GoogleWorkforceTokenVerifier,
  IAP_ASSERTION_HEADER,
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER,
  verifyIapBrowserRequest,
  verifyWorkforceRequest
} from "./identity.server";

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
      capabilities: ["source.entity.read"],
      requiredAccessLevels: ["accessPolicies/123/accessLevels/managed-device"]
    }
  ]
};

const serviceClaims: VerifiedTokenClaims = {
  iss: "https://accounts.google.com",
  sub: "100000000000000000001",
  aud: receiverAudience,
  iat: now - 30,
  exp: now + 300,
  email: "renamed-workload@example.iam.gserviceaccount.com"
};

const iapClaims: VerifiedTokenClaims = {
  iss: "https://cloud.google.com/iap",
  sub: "accounts.google.com:100000000000000000099",
  aud: sourceAudience,
  iat: now - 30,
  exp: now + 300,
  email: "renamed-user@example.com",
  google: {
    access_levels: ["accessPolicies/123/accessLevels/managed-device"]
  }
};

const binding: IdentityBinding = {
  actorId: "usr_existing_uuid",
  companyId: "cmp_alpha",
  companyGroupId: "group_alpha",
  bindingActive: true,
  userActive: true,
  membershipActive: true,
  revocationVersion: 7,
  permissionsVersion: "permissions-12",
  capabilities: ["source.entity.read", "source.facts.query"]
};

function request(
  serviceToken = "service-token",
  userEvidence = "iap-token",
  companyId = "cmp_alpha"
) {
  return new Request(
    "https://carbon-api.example.com/api/v1/knowledge/getItemIdentity",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        [PORTAL_USER_EVIDENCE_HEADER]: userEvidence,
        [PORTAL_COMPANY_HEADER]: companyId
      }
    }
  );
}

function verifier(
  service: VerifiedTokenClaims = serviceClaims,
  iap: VerifiedTokenClaims = iapClaims
): TrustedTokenVerifier {
  return {
    verifyServiceToken: async () => service,
    verifyIapToken: async () => iap
  };
}

function identityStore(resolved: IdentityBinding | null = binding) {
  return {
    resolveHuman: async () => resolved
  };
}

describe("trusted workforce forwarding", () => {
  it("verifies both assertions and returns only server-derived identity", async () => {
    const result = await verifyWorkforceRequest({
      request: request(),
      operation: "knowledge_getItemIdentity",
      configuration,
      tokenVerifier: verifier(),
      identityStore: identityStore(),
      nowEpochSeconds: now
    });

    expect(result).toEqual({
      principal: {
        kind: "human",
        actorId: "usr_existing_uuid",
        companyId: "cmp_alpha",
        callerId: "knowledge-query",
        sourceIdentity: {
          issuer: "https://cloud.google.com/iap",
          subject: "accounts.google.com:100000000000000000099"
        },
        policyVersion: "identity-7:permissions-12",
        capabilities: ["source.entity.read"]
      },
      companyGroupId: "group_alpha",
      allowedOperations: ["knowledge_getItemIdentity"],
      accessLevels: ["accessPolicies/123/accessLevels/managed-device"]
    });
  });

  it("retains the canonical actor when email attributes change", async () => {
    const changedEmail = { ...iapClaims, email: "new-address@example.com" };
    const resolveHuman = async (identity: {
      issuer: string;
      subject: string;
      companyId: string;
    }) => {
      expect(identity).toEqual({
        issuer: iapClaims.iss,
        subject: iapClaims.sub,
        companyId: "cmp_alpha"
      });
      return binding;
    };

    const result = await verifyWorkforceRequest({
      request: request(),
      operation: "knowledge_getItemIdentity",
      configuration,
      tokenVerifier: verifier(serviceClaims, changedEmail),
      identityStore: { resolveHuman },
      nowEpochSeconds: now
    });

    expect(result.principal.actorId).toBe("usr_existing_uuid");
  });

  it.each([
    ["missing service assertion", request("", "iap-token")],
    ["missing user evidence", request("service-token", "")],
    [
      "cross-company selection",
      request("service-token", "iap-token", "cmp_beta")
    ]
  ])("rejects %s", async (_name, incoming) => {
    await expect(
      verifyWorkforceRequest({
        request: incoming,
        operation: "knowledge_getItemIdentity",
        configuration,
        tokenVerifier: verifier(),
        identityStore: identityStore(),
        nowEpochSeconds: now
      })
    ).rejects.toThrow(/unauthorized workforce request/i);
  });

  it.each([
    [
      "wrong service audience",
      { ...serviceClaims, aud: "https://other-api.example.com" },
      iapClaims
    ],
    [
      "unregistered service account",
      { ...serviceClaims, sub: "100000000000000000777" },
      iapClaims
    ],
    [
      "wrong IAP audience",
      serviceClaims,
      { ...iapClaims, aud: "/projects/other" }
    ],
    ["expired IAP token", serviceClaims, { ...iapClaims, exp: now - 31 }],
    ["future IAP token", serviceClaims, { ...iapClaims, iat: now + 31 }],
    ["non-finite IAP expiry", serviceClaims, { ...iapClaims, exp: Number.NaN }],
    [
      "fractional IAP issued-at",
      serviceClaims,
      { ...iapClaims, iat: now - 0.5 }
    ],
    [
      "overlong IAP token lifetime",
      serviceClaims,
      { ...iapClaims, iat: now - 700, exp: now + 1 }
    ],
    [
      "missing assurance",
      serviceClaims,
      { ...iapClaims, google: { access_levels: [] } }
    ]
  ])("rejects %s", async (_name, service, iap) => {
    await expect(
      verifyWorkforceRequest({
        request: request(),
        operation: "knowledge_getItemIdentity",
        configuration,
        tokenVerifier: verifier(service, iap),
        identityStore: identityStore(),
        nowEpochSeconds: now
      })
    ).rejects.toThrow(/unauthorized workforce request/i);
  });

  it("coalesces and rate-bounds IAP key refresh after invalid tokens", async () => {
    const getIapPublicKeys = vi.fn(async () => ({ pubkeys: { key: "pem" } }));
    const verifySignedJwtWithCertsAsync = vi.fn(async () => {
      throw new Error("unknown key id");
    });
    const tokenVerifier = new GoogleWorkforceTokenVerifier({
      getIapPublicKeys,
      verifySignedJwtWithCertsAsync
    } as never);

    await Promise.allSettled([
      tokenVerifier.verifyIapToken("invalid-one", sourceAudience),
      tokenVerifier.verifyIapToken("invalid-two", sourceAudience),
      tokenVerifier.verifyIapToken("invalid-three", sourceAudience)
    ]);

    expect(getIapPublicKeys).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unknown subject", null],
    ["disabled binding", { ...binding, bindingActive: false }],
    ["disabled user", { ...binding, userActive: false }],
    ["revoked membership", { ...binding, membershipActive: false }]
  ])("rejects %s", async (_name, resolved) => {
    await expect(
      verifyWorkforceRequest({
        request: request(),
        operation: "knowledge_getItemIdentity",
        configuration,
        tokenVerifier: verifier(),
        identityStore: identityStore(resolved),
        nowEpochSeconds: now
      })
    ).rejects.toThrow(/unauthorized workforce request/i);
  });

  it("rejects a registered caller invoking an unregistered operation", async () => {
    await expect(
      verifyWorkforceRequest({
        request: request(),
        operation: "knowledge_createProcurementDraft",
        configuration,
        tokenVerifier: verifier(),
        identityStore: identityStore(),
        nowEpochSeconds: now
      })
    ).rejects.toThrow(/unauthorized workforce request/i);
  });

  it("does not accept actor, capability, or audit identity request headers", async () => {
    const incoming = request();
    incoming.headers.set("x-portal-actor-id", "usr_forged");
    incoming.headers.set("x-portal-capabilities", "source.facts.query");
    incoming.headers.set("x-portal-audit-actor", "usr_forged");

    await expect(
      verifyWorkforceRequest({
        request: incoming,
        operation: "knowledge_getItemIdentity",
        configuration,
        tokenVerifier: verifier(),
        identityStore: identityStore(),
        nowEpochSeconds: now
      })
    ).rejects.toThrow(/unauthorized workforce request/i);
  });
});

describe("IAP browser boundary", () => {
  it("verifies the browser assertion without requiring a service bearer", async () => {
    const incoming = new Request("https://knowledge.example.com", {
      headers: { [IAP_ASSERTION_HEADER]: "original-iap-assertion" }
    });
    const verifyIapToken = async (token: string, audience: string) => {
      expect(token).toBe("original-iap-assertion");
      expect(audience).toBe(sourceAudience);
      return iapClaims;
    };

    const verified = await verifyIapBrowserRequest({
      request: incoming,
      sourceIapAudience: sourceAudience,
      requiredAccessLevels: ["accessPolicies/123/accessLevels/managed-device"],
      tokenVerifier: { verifyIapToken },
      nowEpochSeconds: now
    });

    expect(verified).toEqual({
      kind: "iap-browser",
      sourceIdentity: { issuer: iapClaims.iss, subject: iapClaims.sub },
      sourceIapAudience: sourceAudience,
      accessLevels: ["accessPolicies/123/accessLevels/managed-device"]
    });
  });

  it("rejects client-supplied delegation and company headers", async () => {
    const incoming = new Request("https://knowledge.example.com", {
      headers: {
        [IAP_ASSERTION_HEADER]: "original-iap-assertion",
        [PORTAL_COMPANY_HEADER]: "cmp_forged"
      }
    });
    await expect(
      verifyIapBrowserRequest({
        request: incoming,
        sourceIapAudience: sourceAudience,
        tokenVerifier: { verifyIapToken: async () => iapClaims },
        nowEpochSeconds: now
      })
    ).rejects.toThrow(/unauthorized workforce request/i);
  });

  it("constructs fresh outbound headers from verified browser evidence", async () => {
    const incoming = new Request("https://knowledge.example.com", {
      headers: {
        Authorization: "Bearer browser-supplied-token",
        [IAP_ASSERTION_HEADER]: "original-iap-assertion",
        "x-portal-actor-id": "usr_forged"
      }
    });
    const verified = {
      kind: "iap-browser" as const,
      sourceIdentity: { issuer: iapClaims.iss!, subject: iapClaims.sub! },
      sourceIapAudience: sourceAudience,
      accessLevels: ["managed-device"]
    };
    const fetchIdToken = async (audience: string) => {
      expect(audience).toBe("https://query.example.com");
      return "fresh-service-token";
    };
    const googleAuth = {
      getIdTokenClient: async () => ({ idTokenProvider: { fetchIdToken } })
    };

    const headers = await createWorkforceForwardingHeaders({
      request: incoming,
      targetAudience: "https://query.example.com",
      companyId: "cmp_alpha",
      verified,
      googleAuth: googleAuth as never
    });

    expect(headers.get("authorization")).toBe("Bearer fresh-service-token");
    expect(headers.get(PORTAL_USER_EVIDENCE_HEADER)).toBe(
      "original-iap-assertion"
    );
    expect(headers.get(PORTAL_COMPANY_HEADER)).toBe("cmp_alpha");
    expect(headers.has("x-portal-actor-id")).toBe(false);
  });
});

describe("machine service authorization", () => {
  it("mints an audience-bound ID token without user evidence", async () => {
    const getIdTokenClient = vi.fn(async (audience: string) => ({
      idTokenProvider: {
        fetchIdToken: async (requestedAudience: string) => {
          expect(requestedAudience).toBe(audience);
          return "fresh-parser-token";
        }
      }
    }));

    await expect(
      createServiceAuthorizationHeader("https://parser.example.com", {
        getIdTokenClient
      } as never)
    ).resolves.toBe("Bearer fresh-parser-token");
    expect(getIdTokenClient).toHaveBeenCalledWith("https://parser.example.com");
  });

  it("rejects an invalid audience before requesting credentials", async () => {
    const getIdTokenClient = vi.fn();
    await expect(
      createServiceAuthorizationHeader("not an audience", {
        getIdTokenClient
      } as never)
    ).rejects.toThrow(/audience/i);
    expect(getIdTokenClient).not.toHaveBeenCalled();
  });
});
