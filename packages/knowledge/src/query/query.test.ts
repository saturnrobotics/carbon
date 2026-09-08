import { describe, expect, it } from "vitest";
import { executeReadQuery } from "./answer.server";

const principal = {
  kind: "human" as const,
  actorId: "alice",
  companyId: "company-a",
  callerId: "web",
  sourceIdentity: { issuer: "iap", subject: "alice" },
  policyVersion: "1",
  capabilities: ["knowledge.read"]
};
const request = {
  requestId: "request-1",
  text: "pull up the NEMA 34 manual",
  mode: "locate" as const,
  locale: "en"
};
const evidence = {
  id: "chunk-a",
  sourceId: "source-a",
  sourceRevision: "1",
  title: "Manual",
  sourceUri: "https://portal.example/documents/doc-a",
  observedAt: "2026-09-01T00:00:00Z",
  policyVersion: "1",
  freshness: "current" as const,
  excerpt: "Connect terminals A and B."
};
describe("bounded read query", () => {
  it("returns locate evidence without answer inference", async () => {
    let calls = 0;
    const result = await executeReadQuery(request, principal, {
      retrieve: async () => [evidence],
      authorize: async () => true,
      synthesize: async () => {
        calls++;
        throw Error("unexpected");
      }
    });
    expect(result.kind).toBe("results");
    expect(result.evidence).toEqual([evidence]);
    expect(calls).toBe(0);
  });
  it("rechecks evidence before synthesis and before delivery", async () => {
    let allowed = true;
    let calls = 0;
    await expect(
      executeReadQuery({ ...request, mode: "read" }, principal, {
        retrieve: async () => [evidence],
        authorize: async () => allowed,
        synthesize: async () => {
          calls++;
          allowed = false;
          return {
            claims: [{ text: "Connect A and B.", evidenceIds: ["chunk-a"] }]
          };
        }
      })
    ).rejects.toThrow("Authorization changed");
    expect(calls).toBe(1);
  });
  it("does not send denied evidence to a model", async () => {
    let calls = 0;
    const result = await executeReadQuery(
      { ...request, mode: "read" },
      principal,
      {
        retrieve: async () => [evidence],
        authorize: async () => false,
        synthesize: async () => {
          calls++;
          throw Error("unexpected");
        }
      }
    );
    expect(result.kind).toBe("abstention");
    expect(result.evidence).toEqual([]);
    expect(calls).toBe(0);
  });
  it("rejects fabricated citations", async () => {
    const result = await executeReadQuery(
      { ...request, mode: "read" },
      principal,
      {
        retrieve: async () => [evidence],
        authorize: async () => true,
        synthesize: async () => ({
          claims: [{ text: "Unsupported", evidenceIds: ["made-up"] }]
        })
      }
    );
    expect(result.kind).toBe("abstention");
    expect(result.claims).toEqual([]);
  });
  it("routes a write request without executing a read model or mutation", async () => {
    let calls = 0;
    const result = await executeReadQuery(
      { ...request, text: "create a ticket to grind the bed", mode: "auto" },
      principal,
      {
        retrieve: async () => {
          calls++;
          return [];
        },
        authorize: async () => true
      }
    );
    expect(result.kind).toBe("command");
    expect(calls).toBe(0);
  });
});
