import type { PoolClient } from "pg";
import {
  chunkJoins,
  chunkProjection,
  type RetrievedChunk
} from "./lexical.server";

/** Ancestor sections are context, never a search: the lineage walk is bounded. */
export const MAX_SECTION_DEPTH = 3;

/**
 * Load the parent-section lineage of already-selected chunks: the chunk with
 * `ordinal = parentOrdinal` in the same document version and embedding
 * profile, then its parent, up to MAX_SECTION_DEPTH. Runs under the reader's
 * base-table policies (client leased through withPortalTransaction "read"),
 * so a section the reader may not see is simply absent. Result maps a child id
 * to its ancestors nearest-first.
 */
export async function loadParentSections(
  client: PoolClient,
  companyId: string,
  chunks: readonly Pick<RetrievedChunk, "id">[]
): Promise<Map<string, RetrievedChunk[]>> {
  const lineage = new Map<string, RetrievedChunk[]>();
  const ids = [...new Set(chunks.map((chunk) => chunk.id))];
  if (ids.length === 0) return lineage;
  if (ids.length > 40) throw new Error("Invalid section expansion bounds");
  const result = await client.query<
    RetrievedChunk & { childId: string; depth: number }
  >(
    `WITH RECURSIVE lineage AS (
      SELECT child.id AS "childId",child."companyId",child."documentVersionId",child."embeddingProfile",
        child."parentOrdinal" AS ordinal,1 AS depth
      FROM portal.chunk child
      WHERE child."companyId"=$1 AND child.id=ANY($2::text[]) AND child."parentOrdinal" IS NOT NULL
      UNION ALL
      SELECT l."childId",p."companyId",p."documentVersionId",p."embeddingProfile",p."parentOrdinal",l.depth+1
      FROM lineage l JOIN portal.chunk p ON p."companyId"=l."companyId" AND p."documentVersionId"=l."documentVersionId"
        AND p."embeddingProfile"=l."embeddingProfile" AND p.ordinal=l.ordinal
      WHERE p."parentOrdinal" IS NOT NULL AND p."parentOrdinal"<>p.ordinal AND l.depth<$3
    )
    SELECT l."childId",l.depth,${chunkProjection}
    FROM lineage l,${chunkJoins}
    WHERE c."companyId"=l."companyId" AND c."documentVersionId"=l."documentVersionId"
      AND c."embeddingProfile"=l."embeddingProfile" AND c.ordinal=l.ordinal
    ORDER BY l."childId",l.depth,c.id`,
    [companyId, ids, MAX_SECTION_DEPTH]
  );
  for (const { childId, depth, ...section } of result.rows) {
    const ancestors = lineage.get(childId) ?? [];
    if (ancestors.length + 1 !== depth)
      throw new Error("Section lineage is not contiguous");
    ancestors.push(section);
    lineage.set(childId, ancestors);
  }
  return lineage;
}
