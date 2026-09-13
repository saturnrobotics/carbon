import { StepUpRequiredError } from "@carbon/portal/step-up";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createReadHandler } from "./query.server";

/**
 * The read handler fails closed on everything, and used to fail closed the same
 * way on everything: one 503 `query_unavailable` for a dead database, a refused
 * identity and another company's question alike. A reader denied the library was
 * told the service was down, and an operator reading the response could not tell
 * a denial from an outage. These pin the three answers apart.
 *
 * The refusals stay opaque about CONTENT: `forbidden` is the whole body for an
 * unknown caller, a revoked binding and a cross-company question, so nothing
 * here reveals that a document exists.
 */
const configuration = {
  version: 1 as const,
  receiver: { id: "query", audience: "query-aud" },
  callers: [
    {
      callerId: "web",
      serviceAccountSubject: "sa-web",
      sourceIapAudience: "iap-web",
      operations: ["portal.query"],
      capabilities: ["portal.read"],
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
    sub: "subject-b",
    aud: "iap-web",
    iat: 900,
    exp: 1200
  })
};

const binding = {
  actorId: "bob",
  companyId: "company-b",
  companyGroupId: "company-b",
  bindingActive: true,
  userActive: true,
  membershipActive: true,
  revocationVersion: 1,
  permissionsVersion: "1",
  capabilities: ["portal.read"]
};

/**
 * The identity cases below refuse before any read, so this stands in for the
 * database. `failWith` makes it the seam for an error raised DURING execution,
 * which is where a source transport's step-up denial really comes from.
 */
function poolThatFails(failWith: Error = new Error("database unavailable")) {
  return {
    connect: () => {
      throw failWith;
    },
    query: () => {
      throw failWith;
    }
  } as unknown as Pool;
}

const unusedPool = poolThatFails();

function handler(overrides: Record<string, unknown> = {}) {
  return createReadHandler({
    pool: unusedPool,
    configuration,
    tokenVerifier,
    nowEpochSeconds: 1000,
    identityStore: { resolveHuman: async () => binding },
    origin: "https://portal.example",
    businessTimezone: "UTC",
    manualSourceId: "source-b",
    cacheStore: { get: async () => undefined, set: async () => undefined },
    ...overrides
  });
}

function query(body: string | undefined = undefined, company = "company-b") {
  return new Request("https://query.example/v1/query", {
    method: "POST",
    headers: {
      authorization: "Bearer service",
      "x-portal-user-evidence": "iap",
      "x-portal-company-id": company,
      "content-type": "application/json"
    },
    body:
      body ??
      JSON.stringify({
        requestId: "r1",
        text: "manual",
        mode: "locate",
        locale: "en"
      })
  });
}

describe("what the read endpoint answers when it refuses", () => {
  it("calls a refused identity a refusal, not an outage", async () => {
    const refuse = handler({
      tokenVerifier: {
        verifyServiceToken: async () => {
          throw new Error("no such caller");
        },
        verifyIapToken: tokenVerifier.verifyIapToken
      }
    });

    const response = await refuse(query());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("gives a revoked binding the same answer, so the refusal names no reason", async () => {
    const revoked = handler({
      identityStore: {
        resolveHuman: async () => ({ ...binding, bindingActive: false })
      }
    });

    const response = await revoked(query());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("gives another company's question that same answer", async () => {
    const response = await handler()(query(undefined, "company-a"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("keeps a real failure an outage", async () => {
    // Verification succeeds; the body does not parse, which is the shape of
    // every non-identity failure inside the handler's one try.
    const response = await handler()(query("not json at all"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "query_unavailable" });
  });

  it("still names a step-up denial raised while the query runs", async () => {
    // A step-up denial comes from a source transport, past verification and
    // inside the same try. It must survive the refusal branch above: the portal
    // sends the reader to Carbon MFA on this code and on no other.
    const stepUp = handler({ pool: poolThatFails(new StepUpRequiredError()) });

    const response = await stepUp(query());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "step_up_required" });
  });

  it("reads a step-up raised INSIDE verification as an identity refusal", async () => {
    // Recorded, not fixed. `verifyWorkforceRequest` wraps its whole body in one
    // catch that rethrows the identity denial, so a step-up raised while
    // resolving an identity is already indistinguishable from an unknown
    // caller — it was a 503 before and is a 403 now, and in neither case does
    // the portal send the reader to Carbon MFA. Unwinding that is a change to
    // the verifier's own catch and belongs with its own proof.
    const inside = handler({
      identityStore: {
        resolveHuman: async () => {
          throw new StepUpRequiredError();
        }
      }
    });

    const response = await inside(query());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });
});
