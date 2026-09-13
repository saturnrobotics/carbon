import { ProviderPolicyRefusal } from "@carbon/knowledge/provider-policy";
import {
  executeReadQuery,
  PROVIDER_POLICY_REFUSED_MESSAGE
} from "@carbon/knowledge/query";
import { createVertexAnswerProvider } from "@carbon/knowledge/query/vertex.server";
import type { RetrievedChunk } from "@carbon/knowledge/retrieval/lexical.server";
import { describe, expect, it, vi } from "vitest";
import { createProviderDisclosure } from "./query.server";

const eligibleText = "Set the drive current to 4 A before homing.";
const restrictedText = "Restricted: torque the spindle nut to 18 N·m.";
function chunk(
  id: string,
  text: string,
  providerPolicy: Record<string, unknown>
): RetrievedChunk {
  return {
    id,
    documentId: `doc-${id}`,
    documentVersionId: `ver-${id}`,
    sourceId: "source-a",
    sourceKind: "upload",
    sourceRevision: "1",
    sourceItemId: "",
    text,
    title: `Manual ${id}`,
    heading: null,
    page: null,
    tokenCount: text.length,
    classification: "internal",
    providerPolicy,
    aclVersion: "1",
    observedAt: "2026-09-01T00:00:00Z"
  };
}
const eligible = chunk("eligible", eligibleText, {
  allowedProviders: ["vertex"],
  allowedClassifications: ["internal"]
});
const restricted = chunk("restricted", restrictedText, {
  allowedProviders: [],
  allowedClassifications: ["internal"]
});
const evidenceFor = (item: RetrievedChunk) => ({
  id: item.id,
  sourceId: item.sourceId,
  documentVersionId: item.documentVersionId,
  sourceRevision: item.sourceRevision,
  title: item.title,
  excerpt: item.text,
  sourceUri: `https://portal.example/documents/${item.documentId}`,
  observedAt: item.observedAt,
  policyVersion: "1",
  freshness: "current" as const
});
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
  text: "what drive current does the manual specify",
  mode: "read" as const,
  locale: "en"
};

function recordingProvider() {
  const bodies: string[] = [];
  const answer = createVertexAnswerProvider(
    {
      version: "synthetic-v1",
      project: "synthetic-project",
      location: "us-central1",
      model: "synthetic-model-001",
      inputMicroUsdPerMillionTokens: 1000000,
      outputMicroUsdPerMillionTokens: 1000000
    },
    {
      accessToken: async () => "synthetic",
      budget: { reserve: async () => undefined, settle: async () => undefined },
      fetch: async (url, init) => {
        bodies.push(String(init?.body));
        return Response.json(
          String(url).endsWith(":countTokens")
            ? { totalTokens: 100 }
            : {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            claims: [
                              { text: "Use 4 A.", evidenceIds: [eligible.id] }
                            ]
                          })
                        }
                      ]
                    }
                  }
                ],
                usageMetadata: {
                  promptTokenCount: 100,
                  candidatesTokenCount: 10,
                  totalTokenCount: 110
                }
              }
        );
      }
    }
  );
  return { answer, bodies };
}
function trace() {
  return {
    record: vi.fn(),
    measure: async <T>(_stage: string, operation: () => Promise<T>) =>
      operation()
  };
}

describe("query service provider disclosure", () => {
  it("re-reads the candidates under current authorization before any policy or provider step", async () => {
    const telemetry = trace();
    const { answer, bodies } = recordingProvider();
    const authorizedCandidates = vi.fn(async () => null);
    const synthesize = createProviderDisclosure({
      providerId: "vertex",
      trace: telemetry,
      authorizedCandidates,
      answer
    });
    await expect(
      synthesize(request, [evidenceFor(eligible)], new AbortController().signal)
    ).rejects.toThrow("Authorization changed");
    expect(authorizedCandidates).toHaveBeenCalledWith([eligible.id]);
    expect(telemetry.record).not.toHaveBeenCalled();
    expect(bodies).toEqual([]);
  });
  it("refuses the whole call and records a model deny when one re-read candidate is ineligible", async () => {
    const telemetry = trace();
    const { answer, bodies } = recordingProvider();
    const synthesize = createProviderDisclosure({
      providerId: "vertex",
      trace: telemetry,
      authorizedCandidates: async () => [eligible, restricted],
      answer
    });
    await expect(
      synthesize(
        request,
        [evidenceFor(eligible), evidenceFor(restricted)],
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(ProviderPolicyRefusal);
    expect(telemetry.record).toHaveBeenCalledWith("model", "deny");
    expect(bodies).toEqual([]);
  });
  it("discloses an all-eligible set and only that set", async () => {
    const telemetry = trace();
    const { answer, bodies } = recordingProvider();
    const synthesize = createProviderDisclosure({
      providerId: "vertex",
      trace: telemetry,
      authorizedCandidates: async () => [eligible],
      answer
    });
    const result = await synthesize(
      request,
      [evidenceFor(eligible)],
      new AbortController().signal
    );
    expect(result).toEqual({
      claims: [{ text: "Use 4 A.", evidenceIds: [eligible.id] }]
    });
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.at(-1)).toContain(eligibleText);
    for (const body of bodies) expect(body).not.toContain(restrictedText);
    expect(telemetry.record).not.toHaveBeenCalledWith("model", "deny");
  });
  it("turns a refusal into evidence-only results for the reader, with the reason stated", async () => {
    const telemetry = trace();
    const { answer, bodies } = recordingProvider();
    const result = await executeReadQuery(request, principal, {
      retrieve: async () => [evidenceFor(eligible), evidenceFor(restricted)],
      authorize: async () => true,
      synthesize: createProviderDisclosure({
        providerId: "vertex",
        trace: telemetry,
        authorizedCandidates: async () => [eligible, restricted],
        answer
      })
    });
    expect(bodies).toEqual([]);
    expect(result.kind).toBe("results");
    expect(result.claims).toEqual([]);
    expect(result.message).toBe(PROVIDER_POLICY_REFUSED_MESSAGE);
    expect(result.evidence.map((item) => item.id)).toEqual([
      eligible.id,
      restricted.id
    ]);
  });
});
