/**
 * Loopback browser-test substitute for the production identity module.
 * It is reachable only through tests/vite.e2e.config.ts when the explicit
 * synthetic-fixture flag is set. Production Vite configuration never resolves
 * this module.
 *
 * Only Google's signature check is synthetic: the assertion travels in a cookie
 * (IAP would place it in the request header), and the production
 * `verifyIapBrowserRequest` decides audience, issuer, freshness and access
 * levels. Forwarding maps the verified subject to the fixture's evidence label.
 */
import {
  IAP_ASSERTION_HEADER,
  UnauthorizedRequestError,
  type VerifiedIapBrowserRequest,
  type VerifiedWorkforceIdentity,
  verifyIapBrowserRequest
} from "@carbon/portal/identity.server";
import {
  ACTOR_COOKIE,
  type Actor,
  ASSERTION_COOKIE,
  actorAssertion,
  actorSubjects,
  SYNTHETIC_ACCESS_LEVEL,
  SYNTHETIC_IAP_AUDIENCE,
  syntheticIapVerifier
} from "./assertion";

const companyId = "company-b";
const actors = new Set<string>(Object.keys(actorSubjects));

function cookie(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Like IAP, the harness overwrites any browser-supplied assertion header. */
function assertionFromCookie(request: Request): string | undefined {
  const assertion = cookie(request, ASSERTION_COOKIE);
  if (assertion) return decodeURIComponent(assertion);
  const actor = cookie(request, ACTOR_COOKIE);
  return actor && actors.has(actor)
    ? actorAssertion(actor as Actor)
    : undefined;
}

export async function verifyPortalBrowserRequest(
  request: Request
): Promise<VerifiedIapBrowserRequest> {
  if (process.env.PORTAL_E2E_SYNTHETIC_FIXTURES !== "1") {
    throw new Error("Synthetic browser identity is disabled");
  }
  const headers = new Headers(request.headers);
  headers.delete(IAP_ASSERTION_HEADER);
  const assertion = assertionFromCookie(request);
  if (assertion) headers.set(IAP_ASSERTION_HEADER, assertion);
  return verifyIapBrowserRequest({
    request: new Request(request.url, { method: request.method, headers }),
    sourceIapAudience: SYNTHETIC_IAP_AUDIENCE,
    requiredAccessLevels: [SYNTHETIC_ACCESS_LEVEL],
    tokenVerifier: syntheticIapVerifier
  });
}

export function forwardVerifiedWorkforceRequest(options: {
  request: Request;
  targetAudience: string;
  companyId: string;
  verified: VerifiedIapBrowserRequest | VerifiedWorkforceIdentity;
}): Promise<Headers> {
  const subject =
    "principal" in options.verified
      ? options.verified.principal.sourceIdentity.subject
      : options.verified.sourceIdentity.subject;
  const actor = (Object.keys(actorSubjects) as Actor[]).find(
    (candidate) => actorSubjects[candidate] === subject
  );
  if (!actor || options.companyId !== companyId || !options.targetAudience) {
    // The production `createWorkforceForwardingHeaders` refuses with the one
    // identity denial, and a handler picks its status from that type. A bare
    // Error here made the harness answer an unknown subject 503 where the
    // deployed portal answers 403 — the harness inventing an outage.
    return Promise.reject(new UnauthorizedRequestError());
  }
  return Promise.resolve(
    new Headers({
      authorization: "Bearer e2e-service",
      "x-portal-user-evidence": `e2e-iap:${actor}`,
      "x-portal-company-id": companyId,
      "x-portal-e2e-identity": "synthetic-loopback-only"
    })
  );
}
