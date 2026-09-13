import type { PoolClient } from "pg";

/** Which ranking produced a chunk; carried onto its evidence block. */
export type RetrievalPath = "lexical" | "vector-exact" | "vector-ann";

export type RetrievedChunk = {
  id: string;
  documentId: string;
  documentVersionId: string;
  sourceId: string;
  sourceKind: string;
  sourceRevision: string;
  sourceItemId: string;
  text: string;
  title: string;
  heading: string | null;
  page: number | null;
  tokenCount: number;
  classification: string;
  providerPolicy: Record<string, unknown>;
  aclVersion: string;
  observedAt: string;
  retrievalPath?: RetrievalPath;
};

export function checkRetrievalBounds(
  query: string,
  sourceIds: readonly string[],
  limit: number
) {
  if (
    !query.trim() ||
    query.length > 8000 ||
    sourceIds.length < 1 ||
    sourceIds.length > 4 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 40
  )
    throw new Error("Invalid retrieval bounds");
}

export const chunkProjection = `c.id,c."documentId",c."documentVersionId",d."sourceId",s.kind AS "sourceKind",v."sourceRevision",d."sourceItemId",
  c.text,d.title,c.heading,c.page,c."tokenCount",d.classification,s."providerPolicy",d."aclVersion",
  to_char(v."observedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"`;
export const chunkJoins = `portal.chunk c JOIN portal.document d ON d.id=c."documentId" AND d."companyId"=c."companyId"
  JOIN portal."documentVersion" v ON v.id=c."documentVersionId" AND v."companyId"=c."companyId"
  JOIN portal.source s ON s.id=d."sourceId" AND s."companyId"=d."companyId"`;

/** client must be leased through withPortalTransaction(..., "read", ...). */
export async function lexicalSearch(
  client: PoolClient,
  companyId: string,
  sourceIds: readonly string[],
  query: string,
  limit = 40
): Promise<RetrievedChunk[]> {
  checkRetrievalBounds(query, sourceIds, limit);
  const result = await client.query<RetrievedChunk>(
    `SELECT * FROM portal.search_lexical($1,$2::text[],$3,$4)`,
    [companyId, sourceIds, query, limit]
  );
  return result.rows.map((row) => ({ ...row, retrievalPath: "lexical" }));
}
