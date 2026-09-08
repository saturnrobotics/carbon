/**
 * Loopback browser-test substitute for the production identity module.
 * It is reachable only through tests/vite.e2e.config.ts when the explicit
 * synthetic-fixture flag is set. Production Vite configuration never resolves
 * this module.
 */
import type {
  VerifiedIapBrowserRequest,
  VerifiedWorkforceIdentity
} from "@carbon/knowledge/identity.server";

const companyId = "company-b";
const issuer = "https://cloud.google.com/iap";
const actors = new Set(["bob", "alice"]);

function testActor(request: Request): "bob" | "alice" {
  if (process.env.KNOWLEDGE_E2E_SYNTHETIC_FIXTURES !== "1") {
    throw new Error("Synthetic browser identity is disabled");
  }
  const actor = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("knowledge_e2e_actor="))
    ?.slice("knowledge_e2e_actor=".length);
  if (!actor || !actors.has(actor)) throw new Error("unauthorized test actor");
  return actor as "bob" | "alice";
}

export async function verifyKnowledgeBrowserRequest(
  request: Request
): Promise<VerifiedIapBrowserRequest> {
  const actor = testActor(request);
  return {
    kind: "iap-browser",
    sourceIdentity: { issuer, subject: `e2e-${actor}` },
    sourceIapAudience: "e2e-loopback-only",
    accessLevels: ["e2e-test"]
  };
}

export function forwardVerifiedWorkforceRequest(options: {
  request: Request;
  targetAudience: string;
  companyId: string;
  verified: VerifiedIapBrowserRequest | VerifiedWorkforceIdentity;
}): Promise<Headers> {
  const actor =
    "principal" in options.verified
      ? options.verified.principal.sourceIdentity.subject.replace(/^e2e-/, "")
      : options.verified.sourceIdentity.subject.replace(/^e2e-/, "");
  if (
    !actors.has(actor) ||
    options.companyId !== companyId ||
    !options.targetAudience
  ) {
    return Promise.reject(new Error("unauthorized test forwarding"));
  }
  return Promise.resolve(
    new Headers({
      authorization: "Bearer e2e-service",
      "x-portal-user-evidence": `e2e-iap:${actor}`,
      "x-portal-company-id": companyId,
      "x-knowledge-e2e-identity": "synthetic-loopback-only"
    })
  );
}
