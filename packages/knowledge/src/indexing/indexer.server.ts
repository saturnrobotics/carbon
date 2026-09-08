import type { Pool, PoolClient } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "../database.server";
import { validateEmbedding } from "../schema-contract";
import type { KnowledgeChunk } from "./chunks";

export type EmbeddedChunk = KnowledgeChunk & {
  embedding: readonly number[];
  tokenCount: number;
};

function vectorLiteral(embedding: readonly number[]): string {
  validateEmbedding(embedding);
  return `[${embedding.join(",")}]`;
}

export async function indexDocumentVersion(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    documentId: string;
    documentVersionId: string;
    embeddingProfile: string;
    indexGeneration: string;
    createdBy: string;
    chunks: readonly EmbeddedChunk[];
  }
): Promise<{ inserted: number }> {
  return withKnowledgeTransaction(pool, principal, "write", async (client) =>
    indexDocumentVersionInTransaction(client, principal, input)
  );
}

export async function indexDocumentVersionInTransaction(
  client: PoolClient,
  principal: DatabasePrincipal,
  input: {
    documentId: string;
    documentVersionId: string;
    embeddingProfile: string;
    indexGeneration: string;
    createdBy: string;
    chunks: readonly EmbeddedChunk[];
  }
): Promise<{ inserted: number }> {
  const rows = input.chunks.map((chunk) => ({
    ordinal: chunk.ordinal,
    text: chunk.text,
    heading: chunk.parentHeading ?? null,
    page: chunk.page,
    bounds: chunk.bounds ?? null,
    parentOrdinal: chunk.parentOrdinal ?? null,
    tokenCount: chunk.tokenCount,
    embedding: vectorLiteral(chunk.embedding)
  }));
  if (!rows.length) return { inserted: 0 };
  const result = await client.query(
    `INSERT INTO knowledge.chunk ("companyId","createdBy","documentId","documentVersionId",ordinal,text,heading,page,bounds,"parentOrdinal","tokenCount",embedding,"embeddingProfile","indexGeneration")
     SELECT $1,$2,$3,$4,c.ordinal,c.text,c.heading,c.page,c.bounds,c."parentOrdinal",c."tokenCount",c.embedding::extensions.vector,$6,$7
     FROM jsonb_to_recordset($5::jsonb) AS c(ordinal integer,text text,heading text,page integer,bounds jsonb,"parentOrdinal" integer,"tokenCount" integer,embedding text)
     ON CONFLICT ("companyId","documentVersionId",ordinal,"embeddingProfile") DO NOTHING`,
    [
      principal.companyId,
      input.createdBy,
      input.documentId,
      input.documentVersionId,
      JSON.stringify(rows),
      input.embeddingProfile,
      input.indexGeneration
    ]
  );
  return { inserted: result.rowCount ?? 0 };
}

export async function embedCurrentDocumentVersion(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    documentId: string;
    createdBy: string;
    embeddingProfile: string;
    embedBatch: (
      texts: readonly string[]
    ) => Promise<
      readonly ({ embedding: readonly number[]; tokenCount: number } | null)[]
    >;
  }
): Promise<{ inserted: number }> {
  const pending = await withKnowledgeTransaction(
    pool,
    principal,
    "read",
    async (client) => {
      const result = await client.query<{
        documentVersionId: string;
        indexGeneration: string;
        ordinal: number;
        page: number;
        text: string;
        heading: string | null;
        bounds: unknown;
        parentOrdinal: number | null;
        tokenCount: number;
        classification: string;
        providerPolicy: unknown;
      }>(
        `SELECT c."documentVersionId",c."indexGeneration"::text AS "indexGeneration",c.ordinal,c.page,c.text,c.heading,c.bounds,c."parentOrdinal",c."tokenCount",d.classification,s."providerPolicy"
       FROM knowledge.document d JOIN knowledge.source s ON s."companyId"=d."companyId" AND s.id=d."sourceId"
       JOIN knowledge.chunk c ON c."companyId"=d."companyId" AND c."documentId"=d.id AND c."documentVersionId"=d."currentVersionId" AND c."embeddingProfile"='lexical-v1'
       WHERE d."companyId"=$1 AND d.id=$2 AND d.status='published' AND d."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM knowledge.chunk embedded WHERE embedded."companyId"=c."companyId" AND embedded."documentVersionId"=c."documentVersionId" AND embedded.ordinal=c.ordinal AND embedded."embeddingProfile"=$3)
       ORDER BY c.ordinal LIMIT 500`,
        [principal.companyId, input.documentId, input.embeddingProfile]
      );
      for (const row of result.rows) {
        const policy =
          row.providerPolicy &&
          typeof row.providerPolicy === "object" &&
          !Array.isArray(row.providerPolicy)
            ? (row.providerPolicy as Record<string, unknown>)
            : {};
        if (
          !Array.isArray(policy.allowedProviders) ||
          !policy.allowedProviders.includes("vertex") ||
          !Array.isArray(policy.allowedClassifications) ||
          !policy.allowedClassifications.includes(row.classification)
        )
          throw new Error("source policy does not permit Vertex indexing");
      }
      return result.rows;
    }
  );
  if (!pending.length) return { inserted: 0 };
  const results = await input.embedBatch(pending.map((chunk) => chunk.text));
  if (results.length !== pending.length)
    throw new Error("embedding provider returned the wrong vector count");
  const first = pending[0];
  if (!first) return { inserted: 0 };
  const chunks = pending.flatMap((chunk, index) => {
    const result = results[index];
    return result
      ? [
          {
            ordinal: chunk.ordinal,
            page: chunk.page,
            text: chunk.text,
            parentHeading: chunk.heading ?? undefined,
            bounds: chunk.bounds,
            parentOrdinal: chunk.parentOrdinal ?? undefined,
            tokenCount: result.tokenCount,
            embedding: result.embedding
          }
        ]
      : [];
  });
  const indexed = await indexDocumentVersion(pool, principal, {
    documentId: input.documentId,
    documentVersionId: first.documentVersionId,
    embeddingProfile: input.embeddingProfile,
    indexGeneration: first.indexGeneration,
    createdBy: input.createdBy,
    chunks
  });
  if (chunks.length !== pending.length)
    throw new Error(
      "one or more embedding requests failed after completed chunks were committed"
    );
  return indexed;
}
