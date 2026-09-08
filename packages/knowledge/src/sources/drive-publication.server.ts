import type { Pool } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "../database.server";
import { splitForEmbedding } from "../indexing/chunks";
import type { Evidence, Extraction } from "../intake/contracts";

export type DrivePublicationTarget = {
  documentId: string;
  sourceId: string;
  sourceItemId: string;
  title: string;
  currentSourceRevision: string | null;
  indexGeneration: string;
};

export type DriveObjectReference = {
  objectKey: string;
  generation: string;
  sha256: string;
  mimeType: string;
  bytes: number;
};

export function buildDrivePublicationChunks(extraction: Extraction) {
  return Object.entries(extraction.evidence)
    .flatMap(([heading, entries]) =>
      entries.flatMap((entry: Evidence) =>
        splitForEmbedding(entry.text).map((text) => ({
          heading,
          page: entry.page,
          text,
          bounds: entry.region ? { region: entry.region } : null
        }))
      )
    )
    .filter((chunk) => chunk.text.trim())
    .map((chunk, ordinal) => ({
      ...chunk,
      ordinal,
      tokenCount: Math.max(1, Math.ceil(chunk.text.length / 4))
    }));
}

export async function getDrivePublicationTarget(
  pool: Pool,
  principal: DatabasePrincipal,
  documentId: string,
  sourceId: string
): Promise<DrivePublicationTarget | null> {
  if (principal.actorId)
    throw new Error("Drive publication requires a machine principal");
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<DrivePublicationTarget>(
      `SELECT d.id AS "documentId",d."sourceId",d."sourceItemId",d.title,
        v."sourceRevision" AS "currentSourceRevision",s."contentEpoch"::text AS "indexGeneration"
       FROM knowledge.document d JOIN knowledge.source s ON s."companyId"=d."companyId" AND s.id=d."sourceId" AND s.kind='drive'
       LEFT JOIN knowledge."documentVersion" v ON v."companyId"=d."companyId" AND v.id=d."currentVersionId"
       WHERE d."companyId"=$1 AND d.id=$2 AND d."sourceId"=$3 AND d.status<>'withdrawn' AND d."deletedAt" IS NULL`,
      [principal.companyId, documentId, sourceId]
    );
    return result.rows[0] ?? null;
  });
}

export async function publishDriveDocumentVersion(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    documentId: string;
    sourceId: string;
    sourceRevision: string;
    createdBy: string;
    reference: DriveObjectReference;
    extraction: Extraction;
    parserVersion: string;
    indexGeneration: string;
  }
): Promise<{ documentVersionId: string }> {
  if (principal.actorId)
    throw new Error("Drive publication requires a machine principal");
  const chunks = buildDrivePublicationChunks(input.extraction);
  if (!chunks.length)
    throw new Error("Drive extraction has no citable text to publish");
  if (chunks.length > 500)
    throw new Error("Drive extraction exceeds the index chunk limit");
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const document = await client.query<{
      id: string;
      currentVersionId: string | null;
    }>(
      `SELECT id,"currentVersionId" FROM knowledge.document
       WHERE "companyId"=$1 AND id=$2 AND "sourceId"=$3 AND status<>'withdrawn' AND "deletedAt" IS NULL FOR UPDATE`,
      [principal.companyId, input.documentId, input.sourceId]
    );
    if (!document.rows[0])
      throw new Error("Drive document changed before publication");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO knowledge."documentVersion" ("companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,'ready')
       ON CONFLICT ("companyId","documentId","sourceRevision") DO NOTHING RETURNING id`,
      [
        principal.companyId,
        input.createdBy,
        input.documentId,
        input.sourceRevision,
        input.reference.sha256,
        input.reference.objectKey,
        input.reference.generation,
        input.reference.mimeType,
        input.reference.bytes,
        input.parserVersion
      ]
    );
    const version =
      inserted.rows[0] ??
      (
        await client.query<{ id: string; contentHash: string }>(
          `SELECT id,"contentHash" FROM knowledge."documentVersion" WHERE "companyId"=$1 AND "documentId"=$2 AND "sourceRevision"=$3`,
          [principal.companyId, input.documentId, input.sourceRevision]
        )
      ).rows[0];
    if (!version)
      throw new Error("Drive document version could not be resolved");
    if (
      "contentHash" in version &&
      version.contentHash !== input.reference.sha256
    )
      throw new Error(
        "Drive revision already contains different immutable content"
      );
    await client.query(
      `INSERT INTO knowledge.chunk ("companyId","createdBy","documentId","documentVersionId",ordinal,text,heading,page,bounds,"tokenCount","embeddingProfile","indexGeneration")
       SELECT $1,$2,$3,$4,c.ordinal,c.text,c.heading,c.page,c.bounds,c."tokenCount",'lexical-v1',$6
       FROM jsonb_to_recordset($5::jsonb) AS c(ordinal integer,text text,heading text,page integer,bounds jsonb,"tokenCount" integer)
       ON CONFLICT ("companyId","documentVersionId",ordinal,"embeddingProfile") DO NOTHING`,
      [
        principal.companyId,
        input.createdBy,
        input.documentId,
        version.id,
        JSON.stringify(chunks),
        input.indexGeneration
      ]
    );
    await client.query(
      `UPDATE knowledge.document SET "currentVersionId"=$3,status='published',"updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND id=$4 AND "currentVersionId" IS DISTINCT FROM $3`,
      [principal.companyId, input.createdBy, version.id, input.documentId]
    );
    return { documentVersionId: version.id };
  });
}
