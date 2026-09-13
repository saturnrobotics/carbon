import { describe, expect, it } from "vitest";
import { evidenceSchema } from "../contracts";
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
  requestId: "citation-request",
  text: "what torque do the terminal screws take",
  mode: "read" as const,
  locale: "en"
};
function chunk(id: string): RetrievedChunk {
  return {
    id,
    documentId: `doc-${id}`,
    documentVersionId: `version-${id}`,
    sourceId: "source-alpha",
    sourceKind: "upload",
    sourceRevision: "1",
    sourceItemId: `item-${id}`,
    text: `Section ${id}: torque to 2 Nm.`,
    title: `Manual ${id}`,
    heading: null,
    page: 3,
    tokenCount: 8,
    classification: "internal",
    providerPolicy: {},
    aclVersion: "1",
    observedAt: "2026-09-01T00:00:00.000Z"
  };
}
const options = {
  origin: "https://portal.example.test",
  policyVersion: "1",
  maxTokens: 7000,
  countTokens: (text: string) => text.length
};

describe("citation to an inaccessible version", () => {
  it("emits a resolvable version URI only for chunks the actor may read", async () => {
    const assembled = await assembleEvidence(
      [chunk("current"), chunk("withdrawn")],
      { ...options, authorize: async (row) => row.id === "current" }
    );
    expect(assembled).toHaveLength(1);
    expect(assembled[0]?.sourceUri).toBe(
      "https://portal.example.test/documents/doc-current/versions/version-current#page=3"
    );
    expect(JSON.stringify(assembled)).not.toContain("withdrawn");
  });

  it("refuses delivery when a cited version becomes inaccessible before the answer leaves", async () => {
    const visible = (
      await assembleEvidence([chunk("current")], {
        ...options,
        authorize: async () => true
      })
    )[0]!;
    let checks = 0;
    await expect(
      executeReadQuery(request, principal, {
        retrieve: async () => [visible],
        authorize: async () => {
          checks += 1;
          return checks === 1;
        },
        synthesize: async () => ({
          claims: [{ text: "2 Nm.", evidenceIds: [visible.id] }]
        })
      })
    ).rejects.toThrow("Authorization changed");
  });

  it("abstains rather than cite a version that was filtered out of the evidence", async () => {
    const [current] = await assembleEvidence(
      [chunk("current"), chunk("withdrawn")],
      {
        ...options,
        authorize: async (row) => row.id === "current"
      }
    );
    const result = await executeReadQuery(request, principal, {
      retrieve: async () => [current!],
      authorize: async () => true,
      synthesize: async () => ({
        claims: [{ text: "2 Nm.", evidenceIds: ["withdrawn"] }]
      })
    });
    expect(result.kind).toBe("abstention");
    expect(result.claims).toEqual([]);
    expect(result.evidence.map((row) => row.id)).toEqual(["current"]);
  });

  it("requires every citation to carry an absolute source URI", () => {
    const [current] = [chunk("current")];
    expect(
      evidenceSchema.safeParse({
        id: current!.id,
        sourceId: current!.sourceId,
        sourceRevision: "1",
        title: current!.title,
        sourceUri: "version-current",
        observedAt: current!.observedAt,
        policyVersion: "1",
        freshness: "current"
      }).success
    ).toBe(false);
  });
});
