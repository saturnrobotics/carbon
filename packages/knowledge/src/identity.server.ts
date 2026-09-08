import { GoogleAuth, OAuth2Client } from "google-auth-library";
import type { PublicKeys } from "google-auth-library/build/src/auth/oauth2client.js";
import { z } from "zod";
import type { Principal } from "./contracts";

export const PORTAL_USER_EVIDENCE_HEADER = "x-portal-user-evidence";
export const PORTAL_COMPANY_HEADER = "x-portal-company-id";
export const IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion";

const GOOGLE_SERVICE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com"
]);
const IAP_ISSUER = "https://cloud.google.com/iap";
const CLOCK_SKEW_SECONDS = 30;
const IAP_MAX_LIFETIME_SECONDS = 10 * 60;
const KEY_CACHE_SECONDS = 5 * 60;
const MINIMUM_KEY_REFRESH_SECONDS = 60;
const FORBIDDEN_IDENTITY_HEADERS = [
  "x-portal-actor-id",
  "x-portal-capabilities",
  "x-portal-audit-actor",
  "x-serverless-authorization"
] as const;

const boundedString = z.string().trim().min(1).max(2_048);
const callerSchema = z
  .object({
    callerId: boundedString,
    serviceAccountSubject: boundedString,
    sourceIapAudience: boundedString,
    operations: z.array(boundedString).min(1).max(100),
    capabilities: z.array(boundedString).max(100),
    requiredAccessLevels: z.array(boundedString).max(20)
  })
  .strict();

export const trustedCallerConfigurationSchema = z
  .object({
    version: z.literal(1),
    receiver: z.object({ id: boundedString, audience: boundedString }).strict(),
    callers: z.array(callerSchema).min(1).max(100)
  })
  .strict()
  .superRefine((configuration, context) => {
    const subjects = new Set<string>();
    for (const [index, caller] of configuration.callers.entries()) {
      if (subjects.has(caller.serviceAccountSubject)) {
        context.addIssue({
          code: "custom",
          path: ["callers", index, "serviceAccountSubject"],
          message: "Service-account subjects must be unique"
        });
      }
      subjects.add(caller.serviceAccountSubject);
    }
  });

export interface VerifiedTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  email?: string;
  google?: { access_levels?: string[] };
}

export interface TrustedTokenVerifier {
  verifyServiceToken(
    token: string,
    expectedAudience: string
  ): Promise<VerifiedTokenClaims>;
  verifyIapToken(
    token: string,
    expectedAudience: string
  ): Promise<VerifiedTokenClaims>;
}

export type TrustedCallerConfiguration = z.infer<
  typeof trustedCallerConfigurationSchema
>;

export interface IdentityBinding {
  actorId: string;
  companyId: string;
  companyGroupId: string;
  bindingActive: boolean;
  userActive: boolean;
  membershipActive: boolean;
  revocationVersion: number;
  permissionsVersion: string;
  capabilities: string[];
}

export interface WorkforceIdentityStore {
  resolveHuman(identity: {
    issuer: string;
    subject: string;
    companyId: string;
  }): Promise<IdentityBinding | null>;
}

export interface VerifiedWorkforceIdentity {
  principal: Extract<Principal, { kind: "human" }>;
  companyGroupId: string;
  allowedOperations: string[];
  accessLevels: string[];
}

export interface VerifiedIapBrowserRequest {
  kind: "iap-browser";
  sourceIdentity: { issuer: string; subject: string };
  sourceIapAudience: string;
  accessLevels: string[];
}

function unauthorized(): Error {
  return new Error("unauthorized workforce request");
}

function epochSeconds(): number {
  return Math.floor((performance.timeOrigin + performance.now()) / 1_000);
}

function hasAudience(
  actual: string | string[] | undefined,
  expected: string
): boolean {
  return Array.isArray(actual)
    ? actual.includes(expected)
    : actual === expected;
}

function assertFreshClaims(
  claims: VerifiedTokenClaims,
  now: number,
  maximumLifetime?: number
): void {
  if (
    !claims.sub ||
    !claims.iss ||
    claims.iat === undefined ||
    claims.exp === undefined ||
    !Number.isFinite(claims.iat) ||
    !Number.isFinite(claims.exp) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.exp < now - CLOCK_SKEW_SECONDS ||
    claims.iat > now + CLOCK_SKEW_SECONDS ||
    claims.exp <= claims.iat ||
    (maximumLifetime !== undefined &&
      claims.exp - claims.iat > maximumLifetime + 2 * CLOCK_SKEW_SECONDS)
  ) {
    throw unauthorized();
  }
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw unauthorized();
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw unauthorized();
  return token;
}

function isIdentityBinding(value: unknown): value is IdentityBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.actorId === "string" &&
    typeof binding.companyId === "string" &&
    typeof binding.companyGroupId === "string" &&
    typeof binding.bindingActive === "boolean" &&
    typeof binding.userActive === "boolean" &&
    typeof binding.membershipActive === "boolean" &&
    typeof binding.revocationVersion === "number" &&
    typeof binding.permissionsVersion === "string" &&
    Array.isArray(binding.capabilities) &&
    binding.capabilities.every((capability) => typeof capability === "string")
  );
}

export class GoogleWorkforceTokenVerifier implements TrustedTokenVerifier {
  private readonly oauthClient: OAuth2Client;
  private keys?: { value: PublicKeys; expiresAt: number; refreshedAt: number };
  private keyRefresh?: Promise<PublicKeys>;

  constructor(oauthClient = new OAuth2Client()) {
    this.oauthClient = oauthClient;
  }

  async verifyServiceToken(token: string, expectedAudience: string) {
    const ticket = await this.oauthClient.verifyIdToken({
      idToken: token,
      audience: expectedAudience
    });
    return (ticket.getPayload() as VerifiedTokenClaims | undefined) ?? {};
  }

  async verifyIapToken(token: string, expectedAudience: string) {
    const verify = async (forceRefresh: boolean) => {
      const keys = await this.iapKeys(forceRefresh);
      const ticket = await this.oauthClient.verifySignedJwtWithCertsAsync(
        token,
        keys,
        expectedAudience,
        [IAP_ISSUER],
        IAP_MAX_LIFETIME_SECONDS
      );
      return (ticket.getPayload() as VerifiedTokenClaims | undefined) ?? {};
    };

    try {
      return await verify(false);
    } catch {
      return verify(true);
    }
  }

  private async iapKeys(forceRefresh: boolean): Promise<PublicKeys> {
    const now = epochSeconds();
    if (!forceRefresh && this.keys && this.keys.expiresAt > now) {
      return this.keys.value;
    }
    if (
      forceRefresh &&
      this.keys &&
      now - this.keys.refreshedAt < MINIMUM_KEY_REFRESH_SECONDS
    ) {
      return this.keys.value;
    }
    if (this.keyRefresh) return this.keyRefresh;
    this.keyRefresh = this.oauthClient
      .getIapPublicKeys()
      .then(({ pubkeys }) => {
        this.keys = {
          value: pubkeys,
          expiresAt: now + KEY_CACHE_SECONDS,
          refreshedAt: now
        };
        return pubkeys;
      })
      .finally(() => {
        this.keyRefresh = undefined;
      });
    return this.keyRefresh;
  }
}

export function parseTrustedCallerConfiguration(
  value: string | unknown
): TrustedCallerConfiguration {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return trustedCallerConfigurationSchema.parse(parsed);
}

export async function verifyWorkforceRequest(options: {
  request: Request;
  operation: string;
  configuration: TrustedCallerConfiguration;
  tokenVerifier?: TrustedTokenVerifier;
  identityStore: WorkforceIdentityStore;
  nowEpochSeconds?: number;
}): Promise<VerifiedWorkforceIdentity> {
  try {
    const configuration = trustedCallerConfigurationSchema.parse(
      options.configuration
    );
    for (const header of FORBIDDEN_IDENTITY_HEADERS) {
      if (options.request.headers.has(header)) throw unauthorized();
    }

    const companyId = options.request.headers
      .get(PORTAL_COMPANY_HEADER)
      ?.trim();
    const userEvidence = options.request.headers
      .get(PORTAL_USER_EVIDENCE_HEADER)
      ?.trim();
    if (!companyId || !userEvidence) throw unauthorized();

    const tokenVerifier =
      options.tokenVerifier ?? new GoogleWorkforceTokenVerifier();
    const now = options.nowEpochSeconds ?? epochSeconds();
    const serviceClaims = await tokenVerifier.verifyServiceToken(
      bearerToken(options.request),
      configuration.receiver.audience
    );
    assertFreshClaims(serviceClaims, now);
    if (
      !GOOGLE_SERVICE_ISSUERS.has(serviceClaims.iss ?? "") ||
      !hasAudience(serviceClaims.aud, configuration.receiver.audience)
    ) {
      throw unauthorized();
    }

    const caller = configuration.callers.find(
      (candidate) =>
        candidate.serviceAccountSubject === serviceClaims.sub &&
        candidate.operations.includes(options.operation)
    );
    if (!caller) throw unauthorized();

    const userClaims = await tokenVerifier.verifyIapToken(
      userEvidence,
      caller.sourceIapAudience
    );
    assertFreshClaims(userClaims, now, IAP_MAX_LIFETIME_SECONDS);
    if (
      userClaims.iss !== IAP_ISSUER ||
      !hasAudience(userClaims.aud, caller.sourceIapAudience)
    ) {
      throw unauthorized();
    }

    const accessLevels = userClaims.google?.access_levels ?? [];
    if (
      caller.requiredAccessLevels.some(
        (required) => !accessLevels.includes(required)
      )
    ) {
      throw unauthorized();
    }

    const binding = await options.identityStore.resolveHuman({
      issuer: userClaims.iss,
      subject: userClaims.sub ?? "",
      companyId
    });
    if (
      !binding ||
      binding.companyId !== companyId ||
      !binding.bindingActive ||
      !binding.userActive ||
      !binding.membershipActive
    ) {
      throw unauthorized();
    }

    const currentCapabilities = new Set(binding.capabilities);
    return {
      principal: {
        kind: "human",
        actorId: binding.actorId,
        companyId,
        callerId: caller.callerId,
        sourceIdentity: {
          issuer: userClaims.iss,
          subject: userClaims.sub ?? ""
        },
        policyVersion: `identity-${binding.revocationVersion}:${binding.permissionsVersion}`,
        capabilities: caller.capabilities.filter((capability) =>
          currentCapabilities.has(capability)
        )
      },
      companyGroupId: binding.companyGroupId,
      allowedOperations: [...caller.operations],
      accessLevels: [...accessLevels]
    };
  } catch {
    throw unauthorized();
  }
}

export async function verifyIapBrowserRequest(options: {
  request: Request;
  sourceIapAudience: string;
  requiredAccessLevels?: readonly string[];
  tokenVerifier?: Pick<TrustedTokenVerifier, "verifyIapToken">;
  nowEpochSeconds?: number;
}): Promise<VerifiedIapBrowserRequest> {
  try {
    for (const header of [
      ...FORBIDDEN_IDENTITY_HEADERS,
      PORTAL_USER_EVIDENCE_HEADER,
      PORTAL_COMPANY_HEADER
    ]) {
      if (options.request.headers.has(header)) throw unauthorized();
    }
    const assertion = options.request.headers.get(IAP_ASSERTION_HEADER)?.trim();
    if (!assertion || !options.sourceIapAudience.trim()) throw unauthorized();
    const verifier =
      options.tokenVerifier ?? new GoogleWorkforceTokenVerifier();
    const claims = await verifier.verifyIapToken(
      assertion,
      options.sourceIapAudience
    );
    assertFreshClaims(
      claims,
      options.nowEpochSeconds ?? epochSeconds(),
      IAP_MAX_LIFETIME_SECONDS
    );
    if (
      claims.iss !== IAP_ISSUER ||
      !hasAudience(claims.aud, options.sourceIapAudience)
    ) {
      throw unauthorized();
    }
    const accessLevels = claims.google?.access_levels ?? [];
    if (
      (options.requiredAccessLevels ?? []).some(
        (required) => !accessLevels.includes(required)
      )
    ) {
      throw unauthorized();
    }
    return {
      kind: "iap-browser",
      sourceIdentity: { issuer: claims.iss, subject: claims.sub ?? "" },
      sourceIapAudience: options.sourceIapAudience,
      accessLevels: [...accessLevels]
    };
  } catch {
    throw unauthorized();
  }
}

export async function createWorkforceForwardingHeaders(options: {
  request: Request;
  targetAudience: string;
  companyId: string;
  verified: VerifiedWorkforceIdentity | VerifiedIapBrowserRequest;
  googleAuth?: GoogleAuth;
}): Promise<Headers> {
  const evidenceHeader =
    "kind" in options.verified && options.verified.kind === "iap-browser"
      ? IAP_ASSERTION_HEADER
      : PORTAL_USER_EVIDENCE_HEADER;
  const evidence = options.request.headers.get(evidenceHeader);
  if (
    !evidence?.trim() ||
    !options.targetAudience.trim() ||
    !options.companyId.trim() ||
    (!("kind" in options.verified) &&
      options.verified.principal.companyId !== options.companyId)
  ) {
    throw unauthorized();
  }

  const googleAuth = options.googleAuth ?? new GoogleAuth();
  const client = await googleAuth.getIdTokenClient(options.targetAudience);
  const token = await client.idTokenProvider.fetchIdToken(
    options.targetAudience
  );
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  headers.set(PORTAL_USER_EVIDENCE_HEADER, evidence);
  headers.set(PORTAL_COMPANY_HEADER, options.companyId);
  return headers;
}

/** Mint a fresh receiver-audience ID token for a machine-to-machine call. */
export async function createServiceAuthorizationHeader(
  targetAudience: string,
  googleAuth: GoogleAuth = new GoogleAuth()
): Promise<string> {
  let audience: URL;
  try {
    audience = new URL(targetAudience);
  } catch {
    throw new Error("Invalid service audience");
  }
  if (
    audience.protocol !== "https:" ||
    audience.username ||
    audience.password ||
    audience.search ||
    audience.hash
  ) {
    throw new Error("Invalid service audience");
  }
  if (targetAudience !== targetAudience.trim()) {
    throw new Error("Invalid service audience");
  }
  const client = await googleAuth.getIdTokenClient(targetAudience);
  const token = await client.idTokenProvider.fetchIdToken(targetAudience);
  if (!token?.trim()) throw new Error("Service authorization unavailable");
  return `Bearer ${token}`;
}

/**
 * Resolve stable identity through the credential-owning query service. This is
 * intended only as the store passed to verifyWorkforceRequest: its callback is
 * reached after both inbound assertions have already passed verification.
 */
export function createRemoteWorkforceIdentityStore(options: {
  request: Request;
  resolverUrl: string;
  resolverAudience: string;
  googleAuth?: GoogleAuth;
  fetch?: typeof globalThis.fetch;
}): WorkforceIdentityStore {
  return {
    async resolveHuman(expected) {
      try {
        const evidence = options.request.headers.get(
          PORTAL_USER_EVIDENCE_HEADER
        );
        if (!evidence?.trim()) return null;
        const googleAuth = options.googleAuth ?? new GoogleAuth();
        const client = await googleAuth.getIdTokenClient(
          options.resolverAudience
        );
        const token = await client.idTokenProvider.fetchIdToken(
          options.resolverAudience
        );
        const response = await (options.fetch ?? globalThis.fetch)(
          options.resolverUrl,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              [PORTAL_USER_EVIDENCE_HEADER]: evidence,
              [PORTAL_COMPANY_HEADER]: expected.companyId
            }
          }
        );
        if (!response.ok) return null;
        const body = (await response.json()) as Record<string, unknown>;
        const identity = body.identity as VerifiedWorkforceIdentity | undefined;
        const binding = body.binding;
        if (
          !identity ||
          identity.principal.kind !== "human" ||
          identity.principal.companyId !== expected.companyId ||
          identity.principal.sourceIdentity.issuer !== expected.issuer ||
          identity.principal.sourceIdentity.subject !== expected.subject ||
          !isIdentityBinding(binding)
        ) {
          return null;
        }
        const verifiedCapabilities = new Set(identity.principal.capabilities);
        if (
          binding.capabilities.some(
            (capability) => !verifiedCapabilities.has(capability)
          )
        ) {
          return null;
        }
        return binding;
      } catch {
        return null;
      }
    }
  };
}
