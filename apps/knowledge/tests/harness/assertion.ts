/**
 * Synthetic IAP assertion for the loopback browser harness. It replaces only the
 * Google signature check: a token is base64url claims plus an HMAC under a fixed
 * test key. Audience, issuer, freshness and access-level checks stay with the
 * production verifier (`verifyIapBrowserRequest`). Test-only; never deployed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  TrustedTokenVerifier,
  VerifiedTokenClaims
} from "@carbon/knowledge/identity.server";

export const SYNTHETIC_IAP_AUDIENCE = "e2e-loopback-only";
export const SYNTHETIC_IAP_ISSUER = "https://cloud.google.com/iap";
export const SYNTHETIC_ACCESS_LEVEL = "e2e-test";
export const SYNTHETIC_SIGNING_KEY = "knowledge-e2e-synthetic-signing-key";
export const ASSERTION_COOKIE = "knowledge_e2e_assertion";
export const ACTOR_COOKIE = "knowledge_e2e_actor";

export const actorSubjects = { bob: "subject-b", alice: "subject-a" } as const;
export type Actor = keyof typeof actorSubjects;

function signature(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function epochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/** Mint an assertion; pass `key` to forge one the harness must reject. */
export function mintSyntheticAssertion(
  claims: VerifiedTokenClaims,
  key = SYNTHETIC_SIGNING_KEY
): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload, key)}`;
}

export function actorAssertion(
  actor: Actor,
  patch: Partial<VerifiedTokenClaims> = {}
) {
  const now = epochSeconds();
  return mintSyntheticAssertion({
    iss: SYNTHETIC_IAP_ISSUER,
    sub: actorSubjects[actor],
    aud: SYNTHETIC_IAP_AUDIENCE,
    iat: now - 5,
    exp: now + 300,
    google: { access_levels: [SYNTHETIC_ACCESS_LEVEL] },
    ...patch
  });
}

/** Returns claims only for a correctly signed token, like a signature failure upstream. */
export const syntheticIapVerifier: Pick<
  TrustedTokenVerifier,
  "verifyIapToken"
> = {
  async verifyIapToken(token) {
    const [payload, provided] = token.split(".");
    if (!payload || !provided) return {};
    const expected = signature(payload, SYNTHETIC_SIGNING_KEY);
    if (
      expected.length !== provided.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
    )
      return {};
    try {
      return JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8")
      ) as VerifiedTokenClaims;
    } catch {
      return {};
    }
  }
};
