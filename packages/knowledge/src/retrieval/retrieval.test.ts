import { describe, expect, it, vi } from "vitest";
import { lexicalSearch } from "./lexical.server";
import { vectorSearch } from "./vector.server";

function client() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] })
  };
}

describe("authorized retrieval boundary", () => {
  it("runs lexical ranking through the bounded database authorization function", async () => {
    const database = client();
    await lexicalSearch(
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
});
