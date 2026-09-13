import { describe, expect, it } from "vitest";
import { executeReadQuery } from "../query/answer.server";
import { assembleEvidence } from "../retrieval/evidence";
import type { RetrievedChunk } from "../retrieval/lexical.server";

const principal = {
  kind: "human" as const,
  actorId: "usr_alex",
  companyId: "cmp_alpha",
  callerId: "portal",
  sourceIdentity: { issuer: "https://cloud.google.com/iap", subject: "alex" },
  policyVersion: "1",
  capabilities: ["portal.read"]
};
const request = {
  requestId: "hidden-request",
  text: "find the manual",
  mode: "locate" as const,
  locale: "en"
};
function evidence(id: string, excerpt: string) {
  return {
    id,
    sourceId: "source-alpha",
    documentVersionId: `version-${id}`,
    sourceRevision: "1",
    title: `Manual ${id}`,
    excerpt,
    sourceUri: `https://portal.example.test/documents/${id}/versions/version-${id}`,
    observedAt: "2026-09-01T00:00:00Z",
    policyVersion: "1",
    freshness: "current" as const
  };
}
function chunk(id: string, text: string): RetrievedChunk {
  return {
    id,
    documentId: `doc-${id}`,
    documentVersionId: `version-${id}`,
    sourceId: "source-alpha",
    sourceKind: "upload",
    sourceRevision: "1",
    sourceItemId: `item-${id}`,
    text,
    title: `Manual ${id}`,
    heading: null,
    page: 1,
    tokenCount: text.length,
    classification: "internal",
    providerPolicy: {},
    aclVersion: "1",
    observedAt: "2026-09-01T00:00:00.000Z"
  };
}
const visible = evidence("visible", "Visible manual section");
const hidden = evidence("hidden", "RESTRICTED manual section");
const options = {
  origin: "https://portal.example.test",
  policyVersion: "1",
  maxTokens: 7000,
  countTokens: (text: string) => text.length
};

describe("hidden-result counting", () => {
  it("returns an identical result whether or not a hidden document also matched", async () => {
    const withHidden = await executeReadQuery(request, principal, {
      retrieve: async () => [visible, hidden],
      authorize: async (item) => item.id !== "hidden"
    });
    const visibleOnly = await executeReadQuery(request, principal, {
      retrieve: async () => [visible],
      authorize: async () => true
    });
    expect(withHidden).toEqual(visibleOnly);
    expect(withHidden.evidence).toHaveLength(1);
    expect(withHidden.partial).toBe(false);
    expect(JSON.stringify(withHidden)).not.toContain("RESTRICTED");
  });

  it("makes a hidden-only match indistinguishable from no match", async () => {
    const hiddenOnly = await executeReadQuery(request, principal, {
      retrieve: async () => [hidden],
      authorize: async () => false
    });
    const nothing = await executeReadQuery(request, principal, {
      retrieve: async () => [],
      authorize: async () => true
    });
    expect(hiddenOnly).toEqual(nothing);
    expect(hiddenOnly.kind).toBe("abstention");
  });

  it("excludes a hidden chunk before it can consume the evidence or token budget", async () => {
    const assembled = await assembleEvidence(
      [
        chunk("hidden", "x".repeat(6_990)),
        chunk("visible", "Visible manual section")
      ],
      { ...options, authorize: async (row) => row.id !== "hidden" }
    );
    expect(assembled.map((row) => row.id)).toEqual(["visible"]);
    const eight = await assembleEvidence(
      [
        ...Array.from({ length: 8 }, (_, index) =>
          chunk(`hidden-${index}`, "restricted")
        ),
        chunk("visible", "Visible manual section")
      ],
      { ...options, authorize: async (row) => row.id === "visible" }
    );
    expect(eight.map((row) => row.id)).toEqual(["visible"]);
  });
});
