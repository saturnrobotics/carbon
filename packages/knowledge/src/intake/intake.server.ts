import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "../database.server";
import {
  type IntakeInput,
  intakeInputSchema,
  type ReviewedManualMetadata,
  reviewedManualMetadataSchema
} from "./contracts";

export type { IntakeInput } from "./contracts";
export {
  type ReviewedManualMetadata,
  reviewedManualMetadataSchema
} from "./contracts";
export { createExtraction, type ParserOutput } from "./extraction.server";

export type CapturedIntake = {
  idempotencyKey: string;
  sourceId: string;
  ownerId: string;
  acl: string;
  input: IntakeInput;
  state: "captured";
};

/** Stable input identity deduplicates retries without merging a source's ACL. */
export function captureIdentity(
  value: Omit<CapturedIntake, "idempotencyKey" | "state">
): CapturedIntake {
  const input = intakeInputSchema.parse(value.input);
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify([value.sourceId, value.ownerId, value.acl, input]))
    .digest("hex");
  return { ...value, input, idempotencyKey, state: "captured" };
}

export async function persistCapturedIntake(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  captured: CapturedIntake
): Promise<{ id: string; generation: string; state: string }> {
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const result = await client.query<{
      id: string;
      generation: string;
      state: string;
    }>(
      `INSERT INTO knowledge.intake ("companyId","createdBy","sourceId","ownerId","inputRefs","idempotencyKey",state)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'captured')
       ON CONFLICT ("companyId","ownerId","idempotencyKey") DO NOTHING
       RETURNING id,generation,state`,
      [
        principal.companyId,
        principal.actorId,
        captured.sourceId,
        captured.ownerId,
        JSON.stringify([{ ...captured.input, acl: captured.acl }]),
        captured.idempotencyKey
      ]
    );
    const persisted =
      result.rows[0] ??
      (
        await client.query<{ id: string; generation: string; state: string }>(
          `SELECT id,generation,state FROM knowledge.intake WHERE "companyId"=$1 AND "ownerId"=$2 AND "idempotencyKey"=$3`,
          [principal.companyId, captured.ownerId, captured.idempotencyKey]
        )
      ).rows[0];
    if (!persisted) throw new Error("intake capture did not return a row");
    await client.query(
      `INSERT INTO knowledge.outbox ("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
       VALUES ($1,$2,$3,'intake',$4::text,$5::text,'upsert',jsonb_build_object('intakeId',$4::text,'generation',$5::text))
       ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO NOTHING`,
      [
        principal.companyId,
        principal.actorId,
        captured.sourceId,
        persisted.id,
        persisted.generation
      ]
    );
    return persisted;
  });
}

export async function getManualUploadSource(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  sourceId: string
): Promise<{ sourceId: string; classification: string }> {
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<{
      sourceId: string;
      classification: string;
    }>(
      `SELECT id AS "sourceId",classification FROM knowledge.source
       WHERE "companyId"=$1 AND id=$2 AND kind='upload' AND status='active'`,
      [principal.companyId, sourceId]
    );
    if (!result.rows[0])
      throw new Error("configured manual source is unavailable");
    return result.rows[0];
  });
}

export function manualReviewDecisions(metadata: unknown): {
  metadata: ReviewedManualMetadata;
  decisions: Record<
    string,
    { value: string; decision: "corrected"; evidence: never[] }
  >;
  unresolved: never[];
} {
  const reviewed = reviewedManualMetadataSchema.parse(metadata);
  return {
    metadata: reviewed,
    decisions: Object.fromEntries(
      Object.entries(reviewed).map(([field, value]) => [
        field,
        { value, decision: "corrected" as const, evidence: [] }
      ])
    ),
    unresolved: []
  };
}

export async function saveReviewDecisions(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  input: {
    intakeId: string;
    expectedGeneration: string;
    expectedVersion: string;
    expectedSourceId: string;
    decisions: unknown;
    unresolved: unknown;
  }
) {
  await withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE knowledge.intake SET "reviewDecisions"=$4::jsonb,unresolved=$5::jsonb,state='ready',"updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE id=$1 AND "companyId"=$3 AND generation=$6 AND version=$7 AND "sourceId"=$8
         AND state IN ('needs-review','ready') AND NOT ("reviewDecisions" ? '__published') RETURNING id`,
      [
        input.intakeId,
        principal.actorId,
        principal.companyId,
        JSON.stringify(input.decisions),
        JSON.stringify(input.unresolved),
        input.expectedGeneration,
        input.expectedVersion,
        input.expectedSourceId
      ]
    );
    if (!result.rows[0])
      throw new Error(
        "intake generation changed; re-read before saving review corrections"
      );
  });
}
