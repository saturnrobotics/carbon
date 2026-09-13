import { describe, expect, it } from "vitest";
import { ProviderPolicyRefusal } from "../provider-policy";
import {
  executeReadQuery,
  NO_EVIDENCE_MESSAGE,
  PROVIDER_POLICY_REFUSED_MESSAGE,
  UNSUPPORTED_ANSWER_MESSAGE
} from "./answer.server";
import { QUERY_BUDGETS } from "./budgets";
import { reauthorizeConversationState } from "./conversation";
import type { QueryStreamEvent } from "./stream";

const principal = {
  kind: "human" as const,
  actorId: "alice",
  companyId: "company-a",
  callerId: "web",
  sourceIdentity: { issuer: "iap", subject: "alice" },
  policyVersion: "1",
  capabilities: ["portal.read"]
};
const request = {
  requestId: "request-1",
  text: "what torque do the terminal screws take",
  mode: "read" as const,
  locale: "en"
};
function evidence(id: string, excerpt: string) {
  return {
    id,
    sourceId: "source-a",
    documentVersionId: `version-${id}`,
    sourceRevision: "1",
    title: `Manual ${id}`,
    excerpt,
    sourceUri: `https://portal.example/documents/doc-${id}/versions/version-${id}`,
    observedAt: "2026-09-01T00:00:00Z",
    policyVersion: "1",
    freshness: "current" as const
  };
}
const a = evidence("chunk-a", "Torque the terminal screws to 2 Nm.");
const b = evidence("chunk-b", "Torque the housing bolts to 4 Nm.");

describe("grounded synthesis", () => {
  it("accepts an answer only when every claim cites delivered evidence", async () => {
    const answer = await executeReadQuery(request, principal, {
      retrieve: async () => [a, b],
      authorize: async () => true,
      synthesize: async () => ({
        claims: [
          { text: "Terminal screws take 2 Nm.", evidenceIds: ["chunk-a"] },
          { text: "Housing bolts take 4 Nm.", evidenceIds: ["chunk-b"] }
        ]
      })
    });
    expect(answer.kind).toBe("answer");
    expect(answer.claims).toHaveLength(2);
    for (const claim of answer.claims)
      for (const id of claim.evidenceIds)
        expect(answer.evidence.some((item) => item.id === id)).toBe(true);
    expect(answer.message).toBe("");
  });
  it("abstains as a whole when one claim cites evidence the reader was not shown", async () => {
    const result = await executeReadQuery(request, principal, {
      retrieve: async () => [a, b],
      authorize: async (item) => item.id !== "chunk-b",
      synthesize: async () => ({
        claims: [
          { text: "Terminal screws take 2 Nm.", evidenceIds: ["chunk-a"] },
          { text: "Housing bolts take 4 Nm.", evidenceIds: ["chunk-b"] }
        ]
      })
    });
    expect(result.kind).toBe("abstention");
    expect(result.claims).toEqual([]);
    expect(result.message).toBe(UNSUPPORTED_ANSWER_MESSAGE);
    expect(result.evidence.map((item) => item.id)).toEqual(["chunk-a"]);
  });
  it("abstains on an empty or malformed synthesis and keeps the evidence", async () => {
    for (const synthesized of [
      { claims: [] },
      { claims: [{ text: "", evidenceIds: ["chunk-a"] }] },
      { claims: [{ text: "Unsupported", evidenceIds: [] }] },
      "not an object",
      undefined
    ]) {
      const result = await executeReadQuery(request, principal, {
        retrieve: async () => [a],
        authorize: async () => true,
        synthesize: async () => synthesized
      });
      expect(result.kind).toBe("abstention");
      expect(result.message).toBe(UNSUPPORTED_ANSWER_MESSAGE);
      expect(result.evidence).toEqual([a]);
    }
  });
  it("never calls a model without evidence and says so", async () => {
    let calls = 0;
    const result = await executeReadQuery(request, principal, {
      retrieve: async () => [],
      authorize: async () => true,
      synthesize: async () => {
        calls++;
        return { claims: [] };
      }
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({
      kind: "abstention",
      evidence: [],
      message: NO_EVIDENCE_MESSAGE
    });
  });
  it("keeps the evidence and names the reason when the provider refuses the set", async () => {
    const result = await executeReadQuery(request, principal, {
      retrieve: async () => [a, b],
      authorize: async () => true,
      synthesize: async () => {
        throw new ProviderPolicyRefusal("vertex", 1);
      }
    });
    expect(result.kind).toBe("results");
    expect(result.message).toBe(PROVIDER_POLICY_REFUSED_MESSAGE);
    expect(result.evidence).toHaveLength(2);
  });
  it("refuses more candidates than the evidence budget allows", async () => {
    const many = Array.from(
      { length: QUERY_BUDGETS.evidenceBlocks + 1 },
      (_, i) => evidence(`chunk-${i}`, `Excerpt ${i}`)
    );
    await expect(
      executeReadQuery(request, principal, {
        retrieve: async () => many,
        authorize: async () => true
      })
    ).rejects.toThrow("Evidence budget exceeded");
  });
});

describe("streamed delivery", () => {
  it("reports authorized evidence before synthesis and nothing a reader would not get", async () => {
    const events: QueryStreamEvent[] = [];
    const result = await executeReadQuery(request, principal, {
      retrieve: async () => [a, b],
      authorize: async (item) => item.id !== "chunk-b",
      synthesize: async () => ({
        claims: [
          { text: "Terminal screws take 2 Nm.", evidenceIds: ["chunk-a"] }
        ]
      }),
      emit: (event) => events.push(event)
    });
    expect(events.map((event) => event.type)).toEqual([
      "progress",
      "evidence",
      "progress"
    ]);
    expect(events[0]).toEqual({
      type: "progress",
      stage: "retrieval",
      state: "started"
    });
    expect(events[1]).toEqual({ type: "evidence", evidence: [a] });
    expect(events[2]).toEqual({
      type: "progress",
      stage: "synthesis",
      state: "started"
    });
    expect(result.kind).toBe("answer");
  });
  it("emits no synthesis stage for a locate route and no evidence when nothing is authorized", async () => {
    const events: QueryStreamEvent[] = [];
    await executeReadQuery({ ...request, mode: "locate" }, principal, {
      retrieve: async () => [a],
      authorize: async () => true,
      synthesize: async () => {
        throw new Error("unexpected");
      },
      emit: (event) => events.push(event)
    });
    expect(events.map((event) => event.type)).toEqual(["progress", "evidence"]);
    const denied: QueryStreamEvent[] = [];
    await executeReadQuery(request, principal, {
      retrieve: async () => [a],
      authorize: async () => false,
      emit: (event) => denied.push(event)
    });
    expect(denied.map((event) => event.type)).toEqual(["progress"]);
  });
});

describe("follow-up context", () => {
  const stored = {
    schema: 1 as const,
    companyId: "company-a",
    actorId: "alice",
    policyVersion: "old",
    evidenceIds: ["chunk-a", "chunk-b"]
  };
  it("is restored only for the same company and actor", async () => {
    const authorize = async () => true;
    expect(
      await reauthorizeConversationState(
        stored,
        { companyId: "company-b", actorId: "alice", policyVersion: "1" },
        authorize
      )
    ).toBeNull();
    expect(
      await reauthorizeConversationState(
        stored,
        { companyId: "company-a", actorId: "bob", policyVersion: "1" },
        authorize
      )
    ).toBeNull();
    expect(
      await reauthorizeConversationState(stored, principal, authorize)
    ).toMatchObject({
      evidenceIds: ["chunk-a", "chunk-b"],
      policyVersion: "1"
    });
  });
  it("carries at most the evidence budget and never a body", async () => {
    const tooMany = {
      ...stored,
      evidenceIds: Array.from(
        { length: QUERY_BUDGETS.conversationEvidence + 1 },
        (_, i) => `chunk-${i}`
      )
    };
    expect(
      await reauthorizeConversationState(tooMany, principal, async () => true)
    ).toBeNull();
    expect(
      await reauthorizeConversationState(
        { ...stored, excerpts: ["leaked text"] },
        principal,
        async () => true
      )
    ).toBeNull();
  });
});
