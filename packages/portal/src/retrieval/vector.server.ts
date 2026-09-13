import type { PoolClient } from "pg";
import { validateEmbedding } from "../schema-contract";
import {
  checkRetrievalBounds,
  type RetrievalPath,
  type RetrievedChunk
} from "./lexical.server";

function serializeQuery(
  sourceIds: readonly string[],
  vector: readonly number[],
  profile: string,
  limit: number
) {
  checkRetrievalBounds(profile, sourceIds, limit);
  validateEmbedding(vector);
  return `[${vector.join(",")}]`;
}

/** Exact authorized baseline preserves recall under highly selective ACLs. */
export async function vectorSearch(
  client: PoolClient,
  companyId: string,
  sourceIds: readonly string[],
  vector: readonly number[],
  profile: string,
  limit = 40
): Promise<RetrievedChunk[]> {
  const serialized = serializeQuery(sourceIds, vector, profile, limit);
  const result = await client.query<RetrievedChunk>(
    `SELECT * FROM portal.search_vector_exact($1,$2::text[],$3,$4,$5)`,
    [companyId, sourceIds, profile, serialized, limit]
  );
  return result.rows.map((row) => ({ ...row, retrievalPath: "vector-exact" }));
}

/**
 * Filtered HNSW ranking with the same ACL predicate as the exact baseline.
 * The database decides the path: an iterative index scan when the installed
 * pgvector supports it, otherwise the exact baseline. Every row reports which
 * one ran so evidence can record it; `retrieval/recall.ts` measures that the
 * index path keeps recall against the baseline before it is trusted.
 */
export async function vectorSearchApproximate(
  client: PoolClient,
  companyId: string,
  sourceIds: readonly string[],
  vector: readonly number[],
  profile: string,
  limit = 40
): Promise<RetrievedChunk[]> {
  const serialized = serializeQuery(sourceIds, vector, profile, limit);
  const result = await client.query<
    RetrievedChunk & { retrievalPath: RetrievalPath }
  >(`SELECT * FROM portal.search_vector_ann($1,$2::text[],$3,$4,$5)`, [
    companyId,
    sourceIds,
    profile,
    serialized,
    limit
  ]);
  for (const row of result.rows) {
    if (
      row.retrievalPath !== "vector-ann" &&
      row.retrievalPath !== "vector-exact"
    )
      throw new Error("Vector search did not report its retrieval path");
  }
  return result.rows;
}
