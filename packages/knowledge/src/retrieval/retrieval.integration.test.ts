import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withKnowledgeTransaction } from "../database.server";
import { getDisposableLocalDatabaseUrl } from "../test/database";
import { lexicalSearch } from "./lexical.server";
import { vectorSearch } from "./vector.server";

describe("real authorized PostgreSQL retrieval", () => {
  const pool = new pg.Pool({
    connectionString: getDisposableLocalDatabaseUrl(),
    max: 1
  });
  beforeAll(async () => {
    // A migration credential supplies a restricted runtime lease; all reads below
    // explicitly SET ROLE knowledge_read, never assert isolation as an owner.
    const client = await pool.connect();
    try {
      await client.query("SET ROLE knowledge_read");
    } finally {
      client.release();
    }
  });
  afterAll(() => pool.end());

  it("retrieves only a permitted version even when a hidden manual has identical bytes", async () => {
    const results = await withKnowledgeTransaction(
      pool,
      { companyId: "company-a", actorId: "alice", callerId: "query" },
      "read",
      (client) => lexicalSearch(client, "company-a", ["source-a"], "manual")
    );
    expect(results.map((row) => row.id)).toEqual(["chunk-doc-a"]);
  });
  it("denies a caller selecting another company", async () => {
    await expect(
      withKnowledgeTransaction(
        pool,
        { companyId: "company-b", actorId: "alice", callerId: "query" },
        "read",
        (client) => lexicalSearch(client, "company-b", ["source-b"], "manual")
      )
    ).rejects.toThrow(/Invalid authorized lexical search/);
  });
  it("rejects wrong embedding dimensionality before issuing SQL", async () => {
    await expect(
      withKnowledgeTransaction(
        pool,
        { companyId: "company-a", actorId: "alice", callerId: "query" },
        "read",
        (client) =>
          vectorSearch(client, "company-a", ["source-a"], [1, 2], "synthetic")
      )
    ).rejects.toThrow("768");
  });
  it("returns no vector candidates when every authorized embedding is null", async () => {
    const vector = Array.from({ length: 768 }, (_, index) =>
      Number(index === 0)
    );
    const results = await withKnowledgeTransaction(
      pool,
      { companyId: "company-a", actorId: "alice", callerId: "query" },
      "read",
      (client) =>
        vectorSearch(client, "company-a", ["source-a"], vector, "synthetic-768")
    );
    expect(results).toEqual([]);
  });
  it("database transaction itself prevents writes", async () => {
    await expect(
      withKnowledgeTransaction(
        pool,
        { companyId: "company-a", actorId: "alice", callerId: "query" },
        "read",
        (client) => client.query("INSERT INTO knowledge.command DEFAULT VALUES")
      )
    ).rejects.toThrow();
  });
});
