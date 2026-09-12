import { describe, expect, it, vi } from "vitest";
import { assembleEvidence, planSectionExpansion } from "./evidence";
import { lexicalSearch, type RetrievedChunk } from "./lexical.server";
import { loadParentSections } from "./sections.server";
import { vectorSearch, vectorSearchApproximate } from "./vector.server";

function client(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows })
  };
}

function chunk(
  id: string,
  overrides: Partial<RetrievedChunk> = {}
): RetrievedChunk {
  return {
    id,
    documentId: "doc-a",
    documentVersionId: "version-doc-a",
    sourceId: "source-a",
    sourceKind: "upload",
    sourceRevision: "1",
    sourceItemId: "manual-a",
    text: `text ${id}`,
    title: "Visible manual",
    heading: null,
    page: null,
    tokenCount: 3,
    classification: "internal",
    providerPolicy: {},
    aclVersion: "1",
    observedAt: "2026-09-11T00:00:00.000Z",
    ...overrides
  };
}

describe("authorized retrieval boundary", () => {
  it("runs lexical ranking through the bounded database authorization function", async () => {
    const database = client([{ id: "chunk-doc-a" }]);
    const rows = await lexicalSearch(
      database as never,
      "company-a",
      ["source-a"],
      "motor manual",
      10
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("knowledge.search_lexical"),
      ["company-a", ["source-a"], "motor manual", 10]
    );
    expect(rows).toEqual([{ id: "chunk-doc-a", retrievalPath: "lexical" }]);
  });

  it("runs exact vector ranking through the bounded database authorization function", async () => {
    const database = client();
    const vector = Array.from({ length: 768 }, (_, index) =>
      Number(index === 0)
    );
    await vectorSearch(
      database as never,
      "company-a",
      ["source-a"],
      vector,
      "vertex-v1",
      10
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("knowledge.search_vector_exact"),
      ["company-a", ["source-a"], "vertex-v1", `[${vector.join(",")}]`, 10]
    );
  });

  it("runs approximate ranking through the filtered index function and keeps the reported path", async () => {
    const vector = Array.from({ length: 768 }, (_, index) =>
      Number(index === 1)
    );
    const database = client([
      { id: "chunk-doc-a", retrievalPath: "vector-ann" }
    ]);
    const rows = await vectorSearchApproximate(
      database as never,
      "company-a",
      ["source-a"],
      vector,
      "vertex-v1",
      10
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("knowledge.search_vector_ann"),
      ["company-a", ["source-a"], "vertex-v1", `[${vector.join(",")}]`, 10]
    );
    expect(rows[0]?.retrievalPath).toBe("vector-ann");
    await expect(
      vectorSearchApproximate(
        client([{ id: "chunk-doc-a" }]) as never,
        "company-a",
        ["source-a"],
        vector,
        "vertex-v1",
        10
      )
    ).rejects.toThrow(/retrieval path/);
    await expect(
      vectorSearchApproximate(
        database as never,
        "company-a",
        ["source-a"],
        [1, 2],
        "vertex-v1",
        10
      )
    ).rejects.toThrow("768");
  });
});

describe("parent-section expansion", () => {
  it("loads bounded lineage for the selected chunks under the reader's policies", async () => {
    const database = client([
      { childId: "c3", depth: 1, ...chunk("c2") },
      { childId: "c3", depth: 2, ...chunk("c1") }
    ]);
    const lineage = await loadParentSections(database as never, "company-a", [
      chunk("c3"),
      chunk("c3")
    ]);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('"parentOrdinal"'),
      ["company-a", ["c3"], 3]
    );
    expect([...lineage.keys()]).toEqual(["c3"]);
    expect(lineage.get("c3")?.map((section) => section.id)).toEqual([
      "c2",
      "c1"
    ]);
    expect(lineage.get("c3")?.[0]).not.toHaveProperty("childId");
    expect(
      await loadParentSections(database as never, "company-a", [])
    ).toEqual(new Map());
    await expect(
      loadParentSections(
        database as never,
        "company-a",
        Array.from({ length: 41 }, (_, index) => chunk(`c${index}`))
      )
    ).rejects.toThrow(/bounds/);
  });

  it("orders selected chunks first, then parents by rank, then grandparents, without repeats", () => {
    const selected = [
      chunk("hit-1", { retrievalPath: "vector-ann" }),
      chunk("hit-2", { retrievalPath: "lexical" }),
      chunk("section-a", { retrievalPath: "lexical" })
    ];
    const lineage = new Map<string, RetrievedChunk[]>([
      ["hit-1", [chunk("section-a"), chunk("chapter-a")]],
      ["hit-2", [chunk("section-b"), chunk("chapter-a")]]
    ]);
    const planned = planSectionExpansion(selected, lineage);
    expect(planned.map((item) => item.id)).toEqual([
      "hit-1",
      "hit-2",
      "section-a",
      "section-b",
      "chapter-a"
    ]);
    expect(planned.map((item) => item.retrievalPath)).toEqual([
      "vector-ann",
      "lexical",
      "lexical",
      "lexical",
      "vector-ann"
    ]);
    expect(planSectionExpansion(selected, lineage)).toEqual(planned);
    expect(planSectionExpansion(selected, new Map())).toEqual(selected);
  });

  it("refuses a lineage that crosses a document version", () => {
    expect(() =>
      planSectionExpansion(
        [chunk("hit")],
        new Map([
          ["hit", [chunk("other", { documentVersionId: "version-doc-b" })]]
        ])
      )
    ).toThrow(/document version/);
  });

  it("expands within the block and token caps and authorizes every section", async () => {
    const selected = Array.from({ length: 6 }, (_, index) =>
      chunk(`hit-${index}`, { retrievalPath: "lexical" })
    );
    const lineage = new Map(
      selected.map((hit, index) => [
        hit.id,
        [chunk(`section-${index}`, { heading: `Section ${index}`, page: 2 })]
      ])
    );
    const denied = new Set(["section-1"]);
    const evidence = await assembleEvidence(selected, {
      origin: "https://knowledge.example.com",
      policyVersion: "policy-1",
      maxTokens: 7000,
      countTokens: (text) => text.length,
      authorize: async (candidate) => !denied.has(candidate.id),
      expandSections: async (chunks) => {
        expect(chunks).toEqual(selected);
        return lineage;
      }
    });
    expect(evidence.map((block) => block.id)).toEqual([
      ...selected.map((hit) => hit.id),
      "section-0",
      "section-2"
    ]);
    expect(evidence[6]).toMatchObject({
      section: "Section 0",
      page: 2,
      retrievalPath: "lexical",
      sourceUri:
        "https://knowledge.example.com/documents/doc-a/versions/version-doc-a#page=2"
    });
    const tokenCapped = await assembleEvidence(selected.slice(0, 1), {
      origin: "https://knowledge.example.com",
      policyVersion: "policy-1",
      maxTokens: 12,
      countTokens: (text) => text.length,
      authorize: async () => true,
      expandSections: async () => lineage
    });
    expect(tokenCapped.map((block) => block.id)).toEqual(["hit-0"]);
  });

  it("does not expand when no lineage loader is supplied", async () => {
    const evidence = await assembleEvidence([chunk("hit")], {
      origin: "https://knowledge.example.com",
      policyVersion: "policy-1",
      maxTokens: 7000,
      countTokens: () => 1,
      authorize: async () => true
    });
    expect(evidence.map((block) => block.id)).toEqual(["hit"]);
    expect(evidence[0]).not.toHaveProperty("retrievalPath");
  });
});
