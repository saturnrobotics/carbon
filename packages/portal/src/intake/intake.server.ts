import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  type DatabasePrincipal,
  withPortalTransaction
} from "../database.server";
import {
  type IntakeInput,
  type ItemAssociation,
  intakeInputSchema,
  itemAssociationSchema,
  type ReviewedManualMetadata,
  reviewedManualMetadataSchema
} from "./contracts";

export type { IntakeInput } from "./contracts";
export {
  type ItemAssociation,
  itemAssociationSchema,
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
  /** Final HTTPS URL an object was acquired from; provenance only, never identity. */
  acquiredFrom?: string;
  /**
   * The name the uploader's own file carried; provenance only, never identity.
   *
   * It is deliberately outside `input`, which is hashed into `idempotencyKey`:
   * the same bytes uploaded twice under two names are still the same capture,
   * and a name in the identity would silently stop deduplicating them.
   */
  fileName?: string;
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
  return withPortalTransaction(pool, principal, "write", async (client) => {
    const result = await client.query<{
      id: string;
      generation: string;
      state: string;
    }>(
      `INSERT INTO portal.intake ("companyId","createdBy","sourceId","ownerId","inputRefs","idempotencyKey",state)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'captured')
       ON CONFLICT ("companyId","ownerId","idempotencyKey") DO NOTHING
       RETURNING id,generation,state`,
      [
        principal.companyId,
        principal.actorId,
        captured.sourceId,
        captured.ownerId,
        JSON.stringify([
          {
            ...captured.input,
            acl: captured.acl,
            ...(captured.acquiredFrom
              ? { acquiredFrom: captured.acquiredFrom }
              : {}),
            ...(captured.fileName ? { fileName: captured.fileName } : {})
          }
        ]),
        captured.idempotencyKey
      ]
    );
    const persisted =
      result.rows[0] ??
      (
        await client.query<{ id: string; generation: string; state: string }>(
          `SELECT id,generation,state FROM portal.intake WHERE "companyId"=$1 AND "ownerId"=$2 AND "idempotencyKey"=$3`,
          [principal.companyId, captured.ownerId, captured.idempotencyKey]
        )
      ).rows[0];
    if (!persisted) throw new Error("intake capture did not return a row");
    await client.query(
      `INSERT INTO portal.outbox ("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
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
  return withPortalTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<{
      sourceId: string;
      classification: string;
    }>(
      `SELECT id AS "sourceId",classification FROM portal.source
       WHERE "companyId"=$1 AND id=$2 AND kind='upload' AND status='active'`,
      [principal.companyId, sourceId]
    );
    if (!result.rows[0])
      throw new Error("configured manual source is unavailable");
    return result.rows[0];
  });
}

export type WritableUploadSource = {
  sourceId: string;
  displayName: string;
  classification: string;
};

/** Upload libraries the current actor may capture into, by the same read grant
 * the intake INSERT policy checks for an owner capture. Bounded to 20 rows. */
export async function getWritableUploadSources(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  options: { onlySourceId?: string } = {}
): Promise<WritableUploadSource[]> {
  return withPortalTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<WritableUploadSource>(
      `SELECT id AS "sourceId","displayName",classification FROM portal.source
       WHERE "companyId"=$1 AND kind='upload' AND status='active'
         AND ($2::text IS NULL OR id=$2) AND portal.can_access("companyId",id)
       ORDER BY "displayName",id LIMIT 20`,
      [principal.companyId, options.onlySourceId ?? null]
    );
    return result.rows;
  });
}

export function manualReviewDecisions(
  metadata: unknown,
  item?: unknown
): {
  metadata: ReviewedManualMetadata;
  item: ItemAssociation | null;
  decisions: Record<
    string,
    {
      value: string | ItemAssociation | null;
      decision: "corrected";
      evidence: never[];
    }
  >;
  unresolved: never[];
} {
  const reviewed = reviewedManualMetadataSchema.parse(metadata);
  const association =
    item === undefined || item === null
      ? null
      : itemAssociationSchema.parse(item);
  return {
    metadata: reviewed,
    item: association,
    decisions: {
      ...Object.fromEntries(
        Object.entries(reviewed).map(([field, value]) => [
          field,
          { value, decision: "corrected" as const, evidence: [] }
        ])
      ),
      // A generic document keeps an explicit "no item" decision so a later
      // re-extraction cannot read silence as an unanswered question.
      item: { value: association, decision: "corrected" as const, evidence: [] }
    },
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
  await withPortalTransaction(pool, principal, "write", async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE portal.intake SET "reviewDecisions"=$4::jsonb,unresolved=$5::jsonb,state='ready',"updatedBy"=$2,"updatedAt"=now(),version=version+1
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
