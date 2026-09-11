/**
 * Drives GoogleWorkforceTokenVerifier against real RSA signatures. Keys are
 * generated in-process and served from a loopback HTTP server that stands in
 * for Google's federated sign-on certificates and IAP public-key documents;
 * nothing here reaches Google.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  IdentityBinding,
  TrustedCallerConfiguration
} from "./identity.server";
import {
  GoogleWorkforceTokenVerifier,
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER,
  verifyWorkforceRequest
} from "./identity.server";

const receiverAudience = "https://carbon-api.example.com";
const sourceAudience =
  "/projects/123456789/locations/us-central1/services/knowledge-web";
const serviceSubject = "100000000000000000001";
const iapSubject = "accounts.google.com:100000000000000000099";
const accessLevel = "accessPolicies/123/accessLevels/managed-device";
const operation = "knowledge_getItemIdentity";
const iapIssuer = "https://cloud.google.com/iap";

const configuration: TrustedCallerConfiguration = {
  version: 1,
  receiver: { id: "carbon-read", audience: receiverAudience },
  callers: [
    {
      callerId: "knowledge-query",
      serviceAccountSubject: serviceSubject,
      sourceIapAudience: sourceAudience,
      operations: [operation],
      capabilities: ["source.entity.read"],
      requiredAccessLevels: [accessLevel]
    }
  ]
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
  capabilities: ["source.entity.read"]
};

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKeyPem: string;
}

function generateSigningKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  return {
    kid,
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** RS256 JWT. `kid` defaults to the signing key's own id; tests override it to forge. */
function signJwt(
  claims: Record<string, unknown>,
  key: SigningKey,
  kid = key.kid
): string {
  const signingInput = `${base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid })
  )}.${base64url(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function nowSeconds(): number {
  return Math.floor((performance.timeOrigin + performance.now()) / 1_000);
}

function serviceClaims(overrides: Record<string, unknown> = {}) {
  const now = nowSeconds();
  return {
    iss: "https://accounts.google.com",
    sub: serviceSubject,
    aud: receiverAudience,
    iat: now - 10,
    exp: now + 300,
    email: "knowledge-query@example.iam.gserviceaccount.com",
    ...overrides
  };
}

function iapClaims(overrides: Record<string, unknown> = {}) {
  const now = nowSeconds();
  return {
    iss: iapIssuer,
    sub: iapSubject,
    aud: sourceAudience,
    iat: now - 10,
    exp: now + 300,
    email: "operator@example.com",
    google: { access_levels: [accessLevel] },
    ...overrides
  };
}

const serviceKey = generateSigningKey("service-current");
const rotatedServiceKey = generateSigningKey("service-next");
const iapKey = generateSigningKey("iap-current");
const rotatedIapKey = generateSigningKey("iap-next");
const rogueKey = generateSigningKey("rogue");

/** The `kid` to PEM documents currently served; tests rotate them in place. */
const served: Record<"service" | "iap", Record<string, string>> = {
  service: {},
  iap: {}
};
const fetches = { service: 0, iap: 0 };
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const kind =
      request.url === "/service-certs"
        ? "service"
        : request.url === "/iap-keys"
          ? "iap"
          : null;
    if (!kind) {
      response.writeHead(404).end();
      return;
    }
    fetches[kind] += 1;
    // Deliberately no Cache-Control: Google sends max-age, this server does
    // not, so the client re-reads the service certificates on every call and a
    // rotation is visible immediately. The IAP cache is the verifier's own.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(served[kind]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  served.service = { [serviceKey.kid]: serviceKey.publicKeyPem };
  served.iap = { [iapKey.kid]: iapKey.publicKeyPem };
  fetches.service = 0;
  fetches.iap = 0;
});

function createVerifier(nowEpochSeconds?: () => number) {
  return new GoogleWorkforceTokenVerifier({
    serviceCertificatesUrl: `${baseUrl}/service-certs`,
    iapPublicKeysUrl: `${baseUrl}/iap-keys`,
    nowEpochSeconds
  });
}

function request(serviceToken: string, userEvidence: string) {
  return new Request(
    "https://carbon-api.example.com/api/v1/knowledge/getItemIdentity",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        [PORTAL_USER_EVIDENCE_HEADER]: userEvidence,
        [PORTAL_COMPANY_HEADER]: "cmp_alpha"
      }
    }
  );
}

describe("GoogleWorkforceTokenVerifier against real signatures", () => {
  it("admits a service ID token and IAP assertion signed by the served keys", async () => {
    const tokenVerifier = createVerifier();
    const result = await verifyWorkforceRequest({
      request: request(
        signJwt(serviceClaims(), serviceKey),
        signJwt(iapClaims(), iapKey)
      ),
      operation,
      configuration,
      tokenVerifier,
      identityStore: {
        resolveHuman: async (identity) => {
          expect(identity).toEqual({
            issuer: iapIssuer,
            subject: iapSubject,
            companyId: "cmp_alpha"
          });
          return binding;
        }
      }
    });

    expect(result.principal).toMatchObject({
      actorId: "usr_existing_uuid",
      callerId: "knowledge-query",
      sourceIdentity: { issuer: iapIssuer, subject: iapSubject }
    });
    expect(fetches).toEqual({ service: 1, iap: 1 });

    await expect(
      verifyWorkforceRequest({
        request: request(
          signJwt(serviceClaims(), serviceKey),
          signJwt(iapClaims(), rogueKey, iapKey.kid)
        ),
        operation,
        configuration,
        tokenVerifier,
        identityStore: { resolveHuman: async () => binding }
      })
    ).rejects.toThrow(/unauthorized workforce request/i);
  });

  it("rejects a payload altered after signing", async () => {
    const tokenVerifier = createVerifier();
    const [iapHeader, , iapSignature] = signJwt(iapClaims(), iapKey).split(".");
    const tamperedAssertion = `${iapHeader}.${base64url(
      JSON.stringify(
        iapClaims({ sub: "accounts.google.com:100000000000000000042" })
      )
    )}.${iapSignature}`;
    await expect(
      tokenVerifier.verifyIapToken(tamperedAssertion, sourceAudience)
    ).rejects.toThrow(/invalid token signature/i);

    const [serviceHeader, , serviceSignature] = signJwt(
      serviceClaims(),
      serviceKey
    ).split(".");
    const tamperedToken = `${serviceHeader}.${base64url(
      JSON.stringify(serviceClaims({ sub: "100000000000000000777" }))
    )}.${serviceSignature}`;
    await expect(
      tokenVerifier.verifyServiceToken(tamperedToken, receiverAudience)
    ).rejects.toThrow(/invalid token signature/i);
  });

  it("rejects a token signed by a key the served document does not contain", async () => {
    const tokenVerifier = createVerifier();
    await expect(
      tokenVerifier.verifyIapToken(
        signJwt(iapClaims(), rogueKey),
        sourceAudience
      )
    ).rejects.toThrow(/no pem found/i);
    await expect(
      tokenVerifier.verifyIapToken(
        signJwt(iapClaims(), rogueKey, iapKey.kid),
        sourceAudience
      )
    ).rejects.toThrow(/invalid token signature/i);
    await expect(
      tokenVerifier.verifyServiceToken(
        signJwt(serviceClaims(), rogueKey),
        receiverAudience
      )
    ).rejects.toThrow(/no pem found/i);
    await expect(
      tokenVerifier.verifyServiceToken(
        signJwt(serviceClaims(), rogueKey, serviceKey.kid),
        receiverAudience
      )
    ).rejects.toThrow(/invalid token signature/i);
  });

  it("stops honouring a rotated-out IAP key once the forced refresh runs", async () => {
    const clock = { now: nowSeconds() };
    const tokenVerifier = createVerifier(() => clock.now);
    const oldAssertion = signJwt(iapClaims(), iapKey);
    await expect(
      tokenVerifier.verifyIapToken(oldAssertion, sourceAudience)
    ).resolves.toMatchObject({ sub: iapSubject });
    expect(fetches.iap).toBe(1);

    served.iap = { [rotatedIapKey.kid]: rotatedIapKey.publicKeyPem };
    const newAssertion = signJwt(iapClaims(), rotatedIapKey);

    // Inside the refresh floor the cached document stands: the retired key
    // still verifies and the new one is refused without a fetch.
    await expect(
      tokenVerifier.verifyIapToken(oldAssertion, sourceAudience)
    ).resolves.toMatchObject({ sub: iapSubject });
    await expect(
      tokenVerifier.verifyIapToken(newAssertion, sourceAudience)
    ).rejects.toThrow(/no pem found/i);
    expect(fetches.iap).toBe(1);

    clock.now += 61;
    await expect(
      tokenVerifier.verifyIapToken(newAssertion, sourceAudience)
    ).resolves.toMatchObject({ sub: iapSubject });
    expect(fetches.iap).toBe(2);
    await expect(
      tokenVerifier.verifyIapToken(oldAssertion, sourceAudience)
    ).rejects.toThrow(/no pem found/i);
    expect(fetches.iap).toBe(2);
  });

  it("stops honouring a rotated-out service certificate on the next fetch", async () => {
    const tokenVerifier = createVerifier();
    const oldToken = signJwt(serviceClaims(), serviceKey);
    await expect(
      tokenVerifier.verifyServiceToken(oldToken, receiverAudience)
    ).resolves.toMatchObject({ sub: serviceSubject });

    served.service = {
      [rotatedServiceKey.kid]: rotatedServiceKey.publicKeyPem
    };
    await expect(
      tokenVerifier.verifyServiceToken(oldToken, receiverAudience)
    ).rejects.toThrow(/no pem found/i);
    await expect(
      tokenVerifier.verifyServiceToken(
        signJwt(serviceClaims(), rotatedServiceKey),
        receiverAudience
      )
    ).resolves.toMatchObject({ sub: serviceSubject });
    expect(fetches.service).toBe(3);
  });

  it("rejects a service token from an issuer other than Google", async () => {
    const tokenVerifier = createVerifier();
    await expect(
      tokenVerifier.verifyServiceToken(
        signJwt(
          serviceClaims({ iss: "https://accounts.example.com" }),
          serviceKey
        ),
        receiverAudience
      )
    ).rejects.toThrow(/invalid issuer/i);
  });

  it("rejects an IAP assertion from an issuer other than IAP", async () => {
    const tokenVerifier = createVerifier();
    await expect(
      tokenVerifier.verifyIapToken(
        signJwt(iapClaims({ iss: "https://accounts.google.com" }), iapKey),
        sourceAudience
      )
    ).rejects.toThrow(/invalid issuer/i);
  });

  it("rejects a service token whose audience is not the receiver", async () => {
    const tokenVerifier = createVerifier();
    await expect(
      tokenVerifier.verifyServiceToken(
        signJwt(
          serviceClaims({ aud: "https://other-api.example.com" }),
          serviceKey
        ),
        receiverAudience
      )
    ).rejects.toThrow(/wrong recipient/i);
    await expect(
      tokenVerifier.verifyServiceToken(
        signJwt(serviceClaims(), serviceKey),
        "https://other-api.example.com"
      )
    ).rejects.toThrow(/wrong recipient/i);
  });
});
