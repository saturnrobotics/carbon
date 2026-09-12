import type { Pool } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "../database.server";

export type OutboxEvent = {
  sourceId: string;
  entityType: string;
  entityId: string;
  sourceVersion: string;
  eventType: OutboxEventType;
};
export const OUTBOX_EVENT_TYPES = [
  "upsert",
  "delete",
  "acl-change",
  "correction",
  "board-change",
  "index-version"
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
/**
 * Indexing delivery owns upserts; every other kind is an invalidation the
 * cache consumer leases (see `INVALIDATION_EVENT_TYPES` in cache/epochs.server).
 */
export const DELIVERY_EVENT_TYPES: readonly OutboxEventType[] = ["upsert"];
export function outboxDedupeKey(event: OutboxEvent): string {
  return [
    event.sourceId,
    event.entityType,
    event.entityId,
    event.sourceVersion,
    event.eventType
  ].join(":");
}
export function prioritizeOutbox(
  events: readonly OutboxEvent[]
): OutboxEvent[] {
  return [...events].sort(
    (left, right) =>
      Number(right.eventType !== "upsert") - Number(left.eventType !== "upsert")
  );
}

export type LeasedOutboxEvent = OutboxEvent & { id: string; payload: unknown };
/**
 * Leases pending events for one consumer. `eventTypes` partitions the outbox
 * between consumers (indexing delivery vs. cache invalidation); each event is
 * leased by exactly one of them. Revocations and tombstones sort first.
 */
export async function claimOutbox(
  pool: Pool,
  principal: DatabasePrincipal,
  workerId: string,
  limit = 50,
  eventTypes: readonly OutboxEventType[] = OUTBOX_EVENT_TYPES
): Promise<LeasedOutboxEvent[]> {
  if (!eventTypes.length) return [];
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    // UPDATE ... RETURNING does not preserve the locking query's order, so the
    // priority is carried through as an ordinal and restored before returning.
    const result = await client.query<LeasedOutboxEvent & { ordinal: string }>(
      `WITH locked AS (
        SELECT id,"createdAt",CASE WHEN "eventType" IN ('delete','acl-change') THEN 0 WHEN "eventType"='upsert' THEN 2 ELSE 1 END AS priority
        FROM knowledge.outbox WHERE "companyId"=$1 AND "deliveredAt" IS NULL AND "availableAt"<=now()
          AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) AND "eventType"=ANY($4::text[])
        ORDER BY 3, "createdAt" LIMIT $2 FOR UPDATE SKIP LOCKED
      ), claimable AS (
        SELECT id,row_number() OVER (ORDER BY priority,"createdAt",id) AS ordinal FROM locked
      ) UPDATE knowledge.outbox o SET "leaseOwner"=$3,"leaseUntil"=now()+interval '5 minutes',attempts=attempts+1,version=version+1
      FROM claimable WHERE o.id=claimable.id AND o."companyId"=$1
      RETURNING o.id,o."sourceId" AS "sourceId",o."entityType" AS "entityType",o."entityId" AS "entityId",o."sourceVersion" AS "sourceVersion",o."eventType" AS "eventType",o.payload,claimable.ordinal`,
      [
        principal.companyId,
        Math.min(Math.max(limit, 1), 100),
        workerId,
        [...new Set(eventTypes)]
      ]
    );
    return result.rows
      .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
      .map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        entityType: row.entityType,
        entityId: row.entityId,
        sourceVersion: row.sourceVersion,
        eventType: row.eventType,
        payload: row.payload
      }));
  });
}

export async function acknowledgeOutbox(
  pool: Pool,
  principal: DatabasePrincipal,
  workerId: string,
  ids: readonly string[]
) {
  if (!ids.length) return;
  await withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const result = await client.query(
      `UPDATE knowledge.outbox SET "deliveredAt"=now(),"leaseOwner"=NULL,"leaseUntil"=NULL,version=version+1 WHERE "companyId"=$1 AND "leaseOwner"=$2 AND id = ANY($3::text[])`,
      [principal.companyId, workerId, ids]
    );
    if (result.rowCount !== ids.length)
      throw new Error("outbox lease was lost before acknowledgement");
  });
}

export type OutboxBacklog = {
  /** Undelivered rows for the company. */
  pending: number;
  /** Age of the oldest undelivered row: how stale the index or an ACL can be. */
  lagSeconds: number;
  /** Age of the oldest row that is claimable but held by no worker: worker starvation. */
  queueSeconds: number;
};
/** Content-free numbers only; the telemetry allowlist carries them to the alert policies. */
export async function outboxBacklog(
  pool: Pool,
  principal: DatabasePrincipal
): Promise<OutboxBacklog> {
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<{
      pending: number;
      lagSeconds: number | null;
      queueSeconds: number | null;
    }>(
      `SELECT count(*)::int AS pending,
        extract(epoch FROM now()-min("createdAt"))::float8 AS "lagSeconds",
        extract(epoch FROM now()-min("availableAt") FILTER (WHERE "availableAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now())))::float8 AS "queueSeconds"
       FROM knowledge.outbox WHERE "companyId"=$1 AND "deliveredAt" IS NULL`,
      [principal.companyId]
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      lagSeconds: Math.max(0, Number(row?.lagSeconds ?? 0)),
      queueSeconds: Math.max(0, Number(row?.queueSeconds ?? 0))
    };
  });
}

export async function confirmOutboxApplied(
  pool: Pool,
  principal: DatabasePrincipal,
  event: LeasedOutboxEvent,
  embeddingProfile?: string
): Promise<void> {
  await withKnowledgeTransaction(pool, principal, "read", async (client) => {
    if (event.entityType === "intake") {
      const result = await client.query(
        `SELECT 1 FROM knowledge.intake WHERE "companyId"=$1 AND id=$2 AND state IN ('needs-review','ready')`,
        [principal.companyId, event.entityId]
      );
      if (!result.rows[0])
        throw new Error("intake extraction has not committed");
      return;
    }
    if (event.entityType !== "document")
      throw new Error("unsupported knowledge outbox entity type");
    if (event.eventType === "delete") {
      const result = await client.query(
        `SELECT 1 FROM knowledge.document WHERE "companyId"=$1 AND id=$2 AND ("deletedAt" IS NOT NULL OR status='withdrawn')`,
        [principal.companyId, event.entityId]
      );
      if (!result.rows[0])
        throw new Error("document deletion has not committed");
      return;
    }
    if (event.eventType === "acl-change") {
      const result = await client.query(
        `SELECT 1 FROM knowledge.document WHERE "companyId"=$1 AND id=$2`,
        [principal.companyId, event.entityId]
      );
      if (!result.rows[0])
        throw new Error("document ACL change has not committed");
      return;
    }
    if (embeddingProfile === "manual-v1") {
      const result = await client.query(
        `SELECT 1 FROM knowledge.document d WHERE d."companyId"=$1 AND d.id=$2
          AND (d."deletedAt" IS NOT NULL OR d.status='withdrawn' OR (
            d.status='published' AND EXISTS (
              SELECT 1 FROM knowledge.chunk c WHERE c."companyId"=d."companyId"
                AND c."documentId"=d.id AND c."documentVersionId"=d."currentVersionId"
                AND c."embeddingProfile"='lexical-v1')))
        `,
        [principal.companyId, event.entityId]
      );
      if (!result.rows[0])
        throw new Error("manual lexical index has not committed");
      return;
    }
    if (!embeddingProfile)
      throw new Error(
        "configured embedding profile is required for acknowledgement"
      );
    const result = await client.query(
      `SELECT 1 AS ready FROM knowledge.document d
       WHERE d."companyId"=$1 AND d.id=$2 AND d.status='published' AND d."deletedAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM knowledge.chunk lexical WHERE lexical."companyId"=d."companyId" AND lexical."documentId"=d.id
           AND lexical."documentVersionId"=d."currentVersionId" AND lexical."embeddingProfile"='lexical-v1'
        )
        AND NOT EXISTS (
          SELECT 1 FROM knowledge.chunk lexical WHERE lexical."companyId"=d."companyId" AND lexical."documentId"=d.id
           AND lexical."documentVersionId"=d."currentVersionId" AND lexical."embeddingProfile"='lexical-v1'
           AND NOT EXISTS (
             SELECT 1 FROM knowledge.chunk embedded WHERE embedded."companyId"=lexical."companyId"
              AND embedded."documentVersionId"=lexical."documentVersionId" AND embedded.ordinal=lexical.ordinal
              AND embedded."embeddingProfile"=$3 AND embedded."indexGeneration"=lexical."indexGeneration" AND embedded.embedding IS NOT NULL
           )
        )`,
      [principal.companyId, event.entityId, embeddingProfile]
    );
    if (!result.rows[0])
      throw new Error("document index generation has not committed");
  });
}
