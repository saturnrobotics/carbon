import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPortalTransaction } from "../database.server";
import { verifyPortalExtensions } from "../migrations.server";
import { getDisposableLocalDatabaseUrl } from "../test/database";
import { lexicalSearch } from "./lexical.server";
import {
  measureFilteredRecall,
  RECALL_AT_10_THRESHOLD,
  selectVectorPath
} from "./recall";
import { loadParentSections } from "./sections.server";
import { vectorSearch, vectorSearchApproximate } from "./vector.server";

const queryVector = Array.from({ length: 768 }, (_, index) =>
  Number(index === 0)
);

/** The disposable fixture's administrative login, as scripts/evaluate.ts uses it. */
function disposableAdminUrl() {
  const url = new URL(getDisposableLocalDatabaseUrl());
  url.username = "supabase_admin";
  url.password = "synthetic-test-only";
  return url.toString();
}

describe("real authorized PostgreSQL retrieval", () => {
  const pool = new pg.Pool({
    connectionString: getDisposableLocalDatabaseUrl(),
    max: 1
  });
  const adminPool = new pg.Pool({
    connectionString: disposableAdminUrl(),
    max: 1
  });
  beforeAll(async () => {
    // A migration credential supplies a restricted runtime lease; all reads below
    // explicitly SET ROLE portal_read, never assert isolation as an owner.
    const client = await pool.connect();
    try {
      await client.query("SET ROLE portal_read");
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  it("retrieves only a permitted version even when a hidden manual has identical bytes", async () => {
    const results = await withPortalTransaction(
      pool,
      { companyId: "company-a", actorId: "alice", callerId: "query" },
      "read",
      (client) => lexicalSearch(client, "company-a", ["source-a"], "manual")
    );
    expect(results.map((row) => row.id)).toEqual(["chunk-doc-a"]);
    expect(results[0]?.retrievalPath).toBe("lexical");
  });
  it("denies a caller selecting another company", async () => {
    await expect(
      withPortalTransaction(
        pool,
        { companyId: "company-b", actorId: "alice", callerId: "query" },
        "read",
        (client) => lexicalSearch(client, "company-b", ["source-b"], "manual")
      )
    ).rejects.toThrow(/Invalid authorized lexical search/);
    await expect(
      withPortalTransaction(
        pool,
        { companyId: "company-b", actorId: "alice", callerId: "query" },
        "read",
        (client) =>
          vectorSearchApproximate(
            client,
            "company-b",
            ["source-b"],
            queryVector,
            "synthetic-768"
          )
      )
    ).rejects.toThrow(/Invalid authorized vector search/);
  });
  it("rejects wrong embedding dimensionality before issuing SQL", async () => {
    await expect(
      withPortalTransaction(
        pool,
        { companyId: "company-a", actorId: "alice", callerId: "query" },
        "read",
        (client) =>
          vectorSearch(client, "company-a", ["source-a"], [1, 2], "synthetic")
      )
    ).rejects.toThrow("768");
  });
  it("returns no vector candidates from either path when every authorized embedding is null", async () => {
    const results = await withPortalTransaction(
      pool,
      { companyId: "company-a", actorId: "alice", callerId: "query" },
      "read",
      async (client) => ({
        exact: await vectorSearch(
          client,
          "company-a",
          ["source-a"],
          queryVector,
          "synthetic-768"
        ),
        approximate: await vectorSearchApproximate(
          client,
          "company-a",
          ["source-a"],
          queryVector,
          "synthetic-768"
        )
      })
    );
    expect(results).toEqual({ exact: [], approximate: [] });
  });
  it("database transaction itself prevents writes", async () => {
    await expect(
      withPortalTransaction(
        pool,
        { companyId: "company-a", actorId: "alice", callerId: "query" },
        "read",
        (client) => client.query("INSERT INTO portal.command DEFAULT VALUES")
      )
    ).rejects.toThrow();
  });

  it("records the installed pgvector version and re-verifies it without drift", async () => {
    const client = await pool.connect();
    try {
      const installed = await client.query<{ version: string }>(
        "SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname='vector'"
      );
      const reports = await verifyPortalExtensions(client);
      expect(reports).toEqual([
        {
          name: "vector",
          installed: installed.rows[0]?.version,
          recorded: installed.rows[0]?.version,
          changed: false
        }
      ]);
    } finally {
      client.release();
    }
  });

  it("expands a selected chunk to its parent sections only where the reader may see them", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      // Rolled back below: a heading section, a subsection and a leaf for both
      // the visible and the hidden manual, all in the profile the fixture uses.
      await client.query(
        `INSERT INTO portal.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,heading,"parentOrdinal","tokenCount","embeddingProfile","indexGeneration")
         SELECT 'section-'||d.id||'-'||s.ordinal,d."companyId",d."createdBy",d.id,'version-'||d.id,s.ordinal,d.title||' section '||s.ordinal,s.heading,s.parent,3,'synthetic-768',1
         FROM portal.document d
         CROSS JOIN (VALUES (1,'Chapter',NULL::integer),(2,'Section',1),(3,NULL,2)) AS s(ordinal,heading,parent)
         WHERE d.id IN ('doc-a','doc-hidden')`
      );
      await client.query("SET LOCAL ROLE portal_read");
      await client.query(
        "SELECT set_config('portal.company_id','company-a',true),set_config('portal.actor_id','alice',true),set_config('portal.caller_id','query',true)"
      );
      const lineage = await loadParentSections(client, "company-a", [
        { id: "section-doc-a-3" },
        { id: "section-doc-hidden-3" },
        { id: "chunk-doc-a" }
      ]);
      expect([...lineage.keys()]).toEqual(["section-doc-a-3"]);
      expect(
        lineage
          .get("section-doc-a-3")
          ?.map((section) => [section.id, section.heading])
      ).toEqual([
        ["section-doc-a-2", "Section"],
        ["section-doc-a-1", "Chapter"]
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps filtered approximate recall at the exact authorized baseline under 10% ACL selectivity", async () => {
    const client = await adminPool.connect();
    try {
      const measurement = await measureFilteredRecall(client);
      const report = JSON.stringify(measurement);
      expect(measurement, report).toMatchObject({
        iterativeScan: true,
        ann: { path: "vector-ann", usesIndex: true },
        postFiltered: { usesIndex: true }
      });
      expect(measurement.selectivity, report).toBeCloseTo(0.1, 3);
      expect(measurement.ann.recallAtK, report).toBeGreaterThanOrEqual(
        RECALL_AT_10_THRESHOLD
      );
      // The negative control: the same index without iterative scans loses
      // recall to post-filtering, which is why the fallback exists.
      expect(measurement.postFiltered.recallAtK, report).toBeLessThan(
        RECALL_AT_10_THRESHOLD
      );
      expect(selectVectorPath(measurement), report).toBe("ann");
      const remaining = await client.query(
        "SELECT count(*)::int AS count FROM portal.chunk WHERE \"embeddingProfile\"='recall-calibration-768'"
      );
      expect(remaining.rows[0]?.count).toBe(0);
    } finally {
      client.release();
    }
  }, 300_000);
});
