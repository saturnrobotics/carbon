import type { PoolClient } from "pg";
import { validateEmbedding } from "../schema-contract";
import { checkRetrievalBounds, type RetrievedChunk } from "./lexical.server";

/** Exact authorized baseline preserves recall under highly selective ACLs. */
export async function vectorSearch(
  client: PoolClient,
  companyId: string,
  sourceIds: readonly string[],
  vector: readonly number[],
  profile: string,
  limit = 40
) {
  checkRetrievalBounds(profile, sourceIds, limit);
  validateEmbedding(vector);
  const serialized = `[${vector.join(",")}]`;
  const result = await client.query<RetrievedChunk>(
    `SELECT * FROM knowledge.search_vector_exact($1,$2::text[],$3,$4,$5)`,
    [companyId, sourceIds, profile, serialized, limit]
  );
  return result.rows;
}
