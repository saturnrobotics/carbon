import { describe, expect, it } from "vitest";
import { embedCurrentDocumentVersion } from "./indexing/indexer.server";
import {
  assertProviderCandidates,
  ProviderPolicyRefusal,
  providerEligible
} from "./provider-policy";
import {
  executeReadQuery,
  PROVIDER_POLICY_REFUSED_MESSAGE
} from "./query/answer.server";
import { createVertexAnswerProvider } from "./query/vertex.server";
import { assembleEvidence } from "./retrieval/evidence";
import type { RetrievedChunk } from "./retrieval/lexical.server";

const ELIGIBLE = {
  allowedProviders: ["vertex"],
  allowedClassifications: ["internal"]
};
function chunk(
  id: string,
  text: string,
  overrides: Partial<RetrievedChunk> = {}
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
    providerPolicy: ELIGIBLE,
    aclVersion: "1",
    observedAt: "2026-09-01T00:00:00Z",
    ...overrides
  };
}
const eligibleText = "Set the drive current to 4 A before homing.";
const ineligibleText = "Restricted: torque the spindle nut to 18 N·m.";
const unauthorizedText = "Hidden: replace the brake pad at 900 hours.";
const eligible = chunk("eligible", eligibleText);
const ineligible = chunk("ineligible", ineligibleText, {
  providerPolicy: {}
});
const unauthorized = chunk("unauthorized", unauthorizedText);

describe("provider eligibility is a source fact", () => {
  it("admits a provider only when the source lists it for the document's classification", () => {
    expect(providerEligible(eligible, "vertex")).toBe(true);
    expect(providerEligible(eligible, "other-provider")).toBe(false);
    expect(
      providerEligible(
        chunk("x", "", {
          providerPolicy: {
            allowedProviders: ["vertex"],
            allowedClassifications: ["public"]
          }
        }),
        "vertex"
      )
    ).toBe(false);
  });
  it("admits nothing by default and nothing for a malformed policy", () => {
    expect(providerEligible(ineligible, "vertex")).toBe(false);
    for (const providerPolicy of [
      { allowedProviders: "vertex", allowedClassifications: ["internal"] },
      { allowedProviders: ["vertex"], allowedClassifications: "internal" },
      { allowedProviders: ["vertex"] },
      { allowedClassifications: ["internal"] }
    ])
      expect(
        providerEligible(chunk("x", "", { providerPolicy }), "vertex")
      ).toBe(false);
  });
});

describe("a provider candidate set is refused whole, never trimmed", () => {
  it("passes an all-eligible set and an empty set", () => {
    expect(() =>
      assertProviderCandidates("vertex", [eligible, chunk("two", "more")])
    ).not.toThrow();
    expect(() => assertProviderCandidates("vertex", [])).not.toThrow();
  });
  it("refuses when any member is ineligible and names only counts", () => {
    let refusal: unknown;
    try {
      assertProviderCandidates("vertex", [eligible, ineligible, eligible]);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProviderPolicyRefusal);
    const typed = refusal as ProviderPolicyRefusal;
    expect(typed.providerId).toBe("vertex");
    expect(typed.refusedCount).toBe(1);
    for (const secret of [
      ineligible.id,
      ineligible.title,
      ineligibleText,
      eligibleText
    ])
      expect(typed.message).not.toContain(secret);
  });
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
const vertex = {
  version: "synthetic-v1",
  project: "synthetic-project",
  location: "us-central1",
  model: "synthetic-model-001",
  inputMicroUsdPerMillionTokens: 1000000,
  outputMicroUsdPerMillionTokens: 1000000
};

/** The read path as the query service composes it, with a recording provider. */
async function readWithProvider(
  candidates: readonly RetrievedChunk[],
  authorized: ReadonlySet<string>
) {
  const providerBodies: string[] = [];
  const answer = createVertexAnswerProvider(vertex, {
    accessToken: async () => "synthetic",
    budget: { reserve: async () => undefined, settle: async () => undefined },
    fetch: async (url, init) => {
      providerBodies.push(String(init?.body));
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
  });
  const result = await executeReadQuery(request, principal, {
    retrieve: async () =>
      assembleEvidence(candidates, {
        origin: "https://portal.example",
        policyVersion: principal.policyVersion,
        maxTokens: 7000,
        countTokens: (text) => text.length,
        authorize: async (item) => authorized.has(item.id)
      }),
    authorize: async (evidence) => authorized.has(evidence.id),
    synthesize: async (input, evidence, signal) => {
      const reread = evidence.map((item) =>
        candidates.find((candidate) => candidate.id === item.id)
      );
      if (reread.some((item) => !item)) throw Error("Authorization changed");
      assertProviderCandidates("vertex", reread as RetrievedChunk[]);
      return answer(input, evidence, signal);
    }
  });
  return { result, providerBodies };
}

describe("eligibility and authorization are independent gates", () => {
  it("sends only text that is both authorized and eligible", async () => {
    const { result, providerBodies } = await readWithProvider(
      [eligible, unauthorized],
      new Set([eligible.id])
    );
    expect(result.kind).toBe("answer");
    expect(result.evidence.map((item) => item.id)).toEqual([eligible.id]);
    expect(providerBodies.length).toBeGreaterThan(0);
    for (const body of providerBodies) {
      expect(body).not.toContain(unauthorizedText);
      expect(body).not.toContain(unauthorized.title);
    }
    expect(providerBodies.at(-1)).toContain(eligibleText);
  });
  it("never discloses an eligible document the reader may not see", async () => {
    const { result, providerBodies } = await readWithProvider(
      [unauthorized],
      new Set()
    );
    expect(result.kind).toBe("abstention");
    expect(result.evidence).toEqual([]);
    expect(providerBodies).toEqual([]);
  });
  it("keeps an ineligible document as the reader's evidence but refuses the provider call whole", async () => {
    const { result, providerBodies } = await readWithProvider(
      [eligible, ineligible],
      new Set([eligible.id, ineligible.id])
    );
    expect(providerBodies).toEqual([]);
    expect(result.kind).toBe("results");
    expect(result.claims).toEqual([]);
    expect(result.message).toBe(PROVIDER_POLICY_REFUSED_MESSAGE);
    expect(result.evidence.map((item) => item.id)).toEqual([
      eligible.id,
      ineligible.id
    ]);
    expect(result.evidence[1]?.excerpt).toBe(ineligibleText);
  });
  it("refuses a candidate set that is entirely ineligible rather than answering from nothing", async () => {
    const { result, providerBodies } = await readWithProvider(
      [ineligible],
      new Set([ineligible.id])
    );
    expect(providerBodies).toEqual([]);
    expect(result.kind).toBe("results");
    expect(result.message).toBe(PROVIDER_POLICY_REFUSED_MESSAGE);
  });
});

describe("index-time embedding honours the same source policy", () => {
  it("refuses to embed a document whose source does not admit the provider, before any request", async () => {
    const pending = {
      documentVersionId: "ver-1",
      indexGeneration: "1",
      ordinal: 1,
      page: 1,
      text: ineligibleText,
      heading: null,
      bounds: null,
      parentOrdinal: null,
      tokenCount: 12,
      classification: "internal",
      providerPolicy: {}
    };
    const client = {
      query: async (sql: string) => ({
        rows: sql.includes("knowledge.chunk embedded") ? [pending] : []
      }),
      release: () => undefined
    };
    const pool = { connect: async () => client };
    const embedded: string[] = [];
    await expect(
      embedCurrentDocumentVersion(
        pool as never,
        { companyId: "company-a", callerId: "worker" },
        {
          documentId: "doc-1",
          createdBy: "system",
          embeddingProfile: "vertex-v1",
          embedBatch: async (texts) => {
            embedded.push(...texts);
            return texts.map(() => null);
          }
        }
      )
    ).rejects.toThrow("source policy does not permit");
    expect(embedded).toEqual([]);
  });
});
