import type { Pool } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "../database.server";
import { splitForEmbedding } from "../indexing/chunks";
import {
  type Evidence,
  type Extraction,
  reviewedManualMetadataSchema
} from "./contracts";

type PublicationRow = {
  intakeId: string;
  sourceId: string;
  ownerId: string;
  generation: string;
  inputRefs: unknown;
  extraction: unknown;
  extractionOutput: unknown;
  reviewDecisions: unknown;
};

type ObjectReference = {
  kind: "object";
  objectKey: string;
  generation: string;
  sha256: string;
  mimeType: string;
  bytes: number;
  acl?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function objectReference(inputRefs: unknown): ObjectReference {
  const value = Array.isArray(inputRefs)
    ? record(inputRefs.find((entry) => record(entry).kind === "object"))
    : {};
  if (
    value.kind !== "object" ||
    typeof value.objectKey !== "string" ||
    typeof value.generation !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.bytes !== "number"
  ) {
    throw new Error("intake has no immutable object generation to publish");
  }
  return value as ObjectReference;
}

function decisionValues(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record(value)).flatMap(([field, raw]) => {
      const decision = record(raw);
      return decision.decision === "rejected" || !("value" in decision)
        ? []
        : [[field, decision.value]];
    })
  );
}

export function buildPublication(row: PublicationRow) {
  const reference = objectReference(row.inputRefs);
  const extracted = record(row.extraction);
  const output = record(row.extractionOutput) as Partial<Extraction>;
  const fields = {
    ...record(output.fields),
    ...extracted,
    ...decisionValues(row.reviewDecisions)
  };
  const reviewedMetadata = reviewedManualMetadataSchema.parse({
    title: stringValue(fields.title, ""),
    manufacturer: stringValue(fields.manufacturer, ""),
    partNumber: stringValue(fields.partNumber, ""),
    revision: stringValue(fields.revision, ""),
    machine: stringValue(fields.machine, "")
  });
  const title = reviewedMetadata.title;
  const classification = stringValue(reference.acl, "internal").slice(0, 256);
  const evidenceChunks = Object.entries(output.evidence ?? {})
    .flatMap(([heading, entries]) =>
      (entries as Evidence[]).flatMap((entry) =>
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
  if (!evidenceChunks.length)
    throw new Error("intake extraction has no citable text to publish");
  if (evidenceChunks.length >= 500)
    throw new Error("intake extraction exceeds the index chunk limit");
  const metadataText = [
    `Title: ${reviewedMetadata.title}`,
    `Manufacturer: ${reviewedMetadata.manufacturer}`,
    `Part number: ${reviewedMetadata.partNumber}`,
    `Revision: ${reviewedMetadata.revision}`,
    `Machine: ${reviewedMetadata.machine}`
  ].join("\n");
  const chunks = [
    {
      ordinal: 0,
      text: metadataText,
      heading: "Reviewed metadata",
      page: null,
      bounds: null,
      tokenCount: Math.max(1, Math.ceil(metadataText.length / 4))
    },
    ...evidenceChunks.map((chunk, index) => ({ ...chunk, ordinal: index + 1 }))
  ];
  return {
    document: {
      sourceItemId: `intake:${row.intakeId}`,
      title,
      ownerId: row.ownerId,
      kind: "manual",
      classification
    },
    version: {
      sourceRevision: `${row.intakeId}:${row.generation}`,
      contentHash: reference.sha256,
      objectKey: reference.objectKey,
      objectGeneration: reference.generation,
      mimeType: reference.mimeType,
      byteCount: reference.bytes,
      reviewedMetadata
    },
    chunks
  };
}

export async function getIntakeForReview(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  intakeId: string
) {
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query(
      `SELECT i.id,i.version,i.generation,i.state,i."sourceId",i."ownerId",i."inputRefs",i.extraction,i."reviewDecisions",i.unresolved,
        e.output AS "extractionOutput" FROM knowledge.intake i
       LEFT JOIN knowledge.extraction e ON e."companyId"=i."companyId" AND e."intakeId"=i.id AND e.generation=i.generation
       WHERE i."companyId"=$1 AND i.id=$2`,
      [principal.companyId, intakeId]
    );
    if (!result.rows[0])
      throw new Error("intake was not found or is not reviewable");
    return result.rows[0];
  });
}

export async function publishReviewedIntake(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  input: {
    intakeId: string;
    expectedGeneration: string;
    expectedVersion: string;
    expectedSourceId: string;
    requestId: string;
  }
): Promise<{
  documentId: string;
  documentVersionId: string;
  sourceRevision: string;
}> {
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${principal.companyId}:${principal.actorId}:${principal.callerId}:${input.requestId}`
    ]);
    const replay = await client.query<{ targetRefs: unknown }>(
      `SELECT "targetRefs" FROM knowledge.audit
       WHERE "companyId"=$1 AND "actorId"=$2 AND "callerId"=$3 AND "requestId"=$4
         AND action='knowledge.intake.publish' LIMIT 1`,
      [
        principal.companyId,
        principal.actorId,
        principal.callerId,
        input.requestId
      ]
    );
    if (replay.rows[0]) {
      const target = Array.isArray(replay.rows[0].targetRefs)
        ? record(replay.rows[0].targetRefs[0])
        : {};
      if (
        target.intakeId !== input.intakeId ||
        target.sourceId !== input.expectedSourceId ||
        target.sourceRevision !==
          `${input.intakeId}:${input.expectedGeneration}` ||
        typeof target.documentId !== "string" ||
        typeof target.documentVersionId !== "string"
      )
        throw new Error("publish request identity was already used");
      return {
        documentId: target.documentId,
        documentVersionId: target.documentVersionId,
        sourceRevision: target.sourceRevision
      };
    }
    const locked = await client.query<
      PublicationRow & { version: string; state: string; unresolved: unknown }
    >(
      `SELECT i.id AS "intakeId",i.version,i.generation,i.state,i."sourceId",i."ownerId",i."inputRefs",i.extraction,i."reviewDecisions",i.unresolved,
        e.output AS "extractionOutput" FROM knowledge.intake i
       JOIN knowledge.extraction e ON e."companyId"=i."companyId" AND e."intakeId"=i.id AND e.generation=i.generation
       WHERE i."companyId"=$1 AND i.id=$2 AND i.generation=$3 AND i.version=$4 AND i."sourceId"=$5 FOR UPDATE OF i`,
      [
        principal.companyId,
        input.intakeId,
        input.expectedGeneration,
        input.expectedVersion,
        input.expectedSourceId
      ]
    );
    const intake = locked.rows[0];
    if (!intake) throw new Error("intake changed; re-read before publishing");
    if (!Array.isArray(intake.unresolved) || intake.unresolved.length)
      throw new Error(
        "intake cannot publish until unresolved fields are acknowledged"
      );
    const publication = buildPublication(intake);

    await client.query(
      `INSERT INTO knowledge.document ("companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'review',$8)
       ON CONFLICT ("companyId","sourceId","sourceItemId") DO NOTHING`,
      [
        principal.companyId,
        principal.actorId,
        intake.sourceId,
        publication.document.sourceItemId,
        publication.document.title,
        publication.document.ownerId,
        publication.document.kind,
        publication.document.classification
      ]
    );
    const existingDocument = (
      await client.query<{
        id: string;
        status: string;
        deletedAt: string | null;
      }>(
        `SELECT id,status,"deletedAt" FROM knowledge.document WHERE "companyId"=$1 AND "sourceId"=$2 AND "sourceItemId"=$3`,
        [
          principal.companyId,
          intake.sourceId,
          publication.document.sourceItemId
        ]
      )
    ).rows[0];
    if (!existingDocument)
      throw new Error("published document could not be resolved");
    if (existingDocument.deletedAt || existingDocument.status === "withdrawn")
      throw new Error("tombstoned manual cannot be republished");

    const insertedVersion = await client.query<{ id: string }>(
      `INSERT INTO knowledge."documentVersion" ("companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus","reviewedMetadata")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),'knowledge-worker-v1','ready',$10::jsonb)
       ON CONFLICT ("companyId","documentId","sourceRevision") DO NOTHING RETURNING id`,
      [
        principal.companyId,
        principal.actorId,
        existingDocument.id,
        publication.version.sourceRevision,
        publication.version.contentHash,
        publication.version.objectKey,
        publication.version.objectGeneration,
        publication.version.mimeType,
        publication.version.byteCount,
        JSON.stringify(publication.version.reviewedMetadata)
      ]
    );
    const existingVersion =
      insertedVersion.rows[0] ??
      (
        await client.query<{ id: string }>(
          `SELECT id FROM knowledge."documentVersion" WHERE "companyId"=$1 AND "documentId"=$2 AND "sourceRevision"=$3`,
          [
            principal.companyId,
            existingDocument.id,
            publication.version.sourceRevision
          ]
        )
      ).rows[0];
    if (!existingVersion)
      throw new Error("published version could not be resolved");

    await client.query(
      `INSERT INTO knowledge.chunk ("companyId","createdBy","documentId","documentVersionId",ordinal,text,heading,page,bounds,"tokenCount","embeddingProfile","indexGeneration")
       SELECT $1,$2,$3,$4,c.ordinal,c.text,c.heading,c.page,c.bounds,c."tokenCount",'lexical-v1',$6
       FROM jsonb_to_recordset($5::jsonb) AS c(ordinal integer,text text,heading text,page integer,bounds jsonb,"tokenCount" integer)
       ON CONFLICT ("companyId","documentVersionId",ordinal,"embeddingProfile") DO NOTHING`,
      [
        principal.companyId,
        principal.actorId,
        existingDocument.id,
        existingVersion.id,
        JSON.stringify(publication.chunks),
        input.expectedGeneration
      ]
    );

    await client.query(
      `UPDATE knowledge.document SET "currentVersionId"=$3,status='published',title=$4,classification=$5,"updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND id=$6 AND "currentVersionId" IS DISTINCT FROM $3`,
      [
        principal.companyId,
        principal.actorId,
        existingVersion.id,
        publication.document.title,
        publication.document.classification,
        existingDocument.id
      ]
    );
    await client.query(
      `INSERT INTO knowledge.outbox ("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
       VALUES ($1,$2,$3,'document',$4::text,$5::text,'upsert',jsonb_build_object('documentId',$4::text,'documentVersionId',$6::text))
       ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO NOTHING`,
      [
        principal.companyId,
        principal.actorId,
        intake.sourceId,
        existingDocument.id,
        publication.version.sourceRevision,
        existingVersion.id
      ]
    );
    const finalized = await client.query(
      `UPDATE knowledge.intake SET state='ready',
         "reviewDecisions"="reviewDecisions" || jsonb_build_object('__published',jsonb_build_object(
           'sourceRevision',$5::text,'documentId',$6::text,'documentVersionId',$7::text)),
         "updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND id=$3 AND version=$4 AND NOT ("reviewDecisions" ? '__published')`,
      [
        principal.companyId,
        principal.actorId,
        input.intakeId,
        input.expectedVersion,
        publication.version.sourceRevision,
        existingDocument.id,
        existingVersion.id
      ]
    );
    if (finalized.rowCount !== 1)
      throw new Error("intake changed; re-read before publishing");
    await client.query(
      `INSERT INTO knowledge.audit ("companyId","createdBy","actorId","callerId","requestId",action,"targetRefs",decision,"policyVersion",metadata)
       VALUES ($1,$2,$2,$3,$4,'knowledge.intake.publish',jsonb_build_array(jsonb_build_object(
         'intakeId',$5::text,'sourceId',$6::text,'sourceRevision',$7::text,
         'documentId',$8::text,'documentVersionId',$9::text)),'allow',$10,'{}')`,
      [
        principal.companyId,
        principal.actorId,
        principal.callerId,
        input.requestId,
        input.intakeId,
        intake.sourceId,
        publication.version.sourceRevision,
        existingDocument.id,
        existingVersion.id,
        `intake-${input.expectedGeneration}`
      ]
    );
    return {
      documentId: existingDocument.id,
      documentVersionId: existingVersion.id,
      sourceRevision: publication.version.sourceRevision
    };
  });
}
