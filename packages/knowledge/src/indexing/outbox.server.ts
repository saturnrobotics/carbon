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
  eventType: "upsert" | "delete" | "acl-change";
};
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
export async function claimOutbox(
  pool: Pool,
  principal: DatabasePrincipal,
  workerId: string,
  limit = 50
): Promise<LeasedOutboxEvent[]> {
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const result = await client.query<LeasedOutboxEvent>(
      `WITH claimable AS (
        SELECT id FROM knowledge.outbox WHERE "companyId"=$1 AND "deliveredAt" IS NULL AND "availableAt"<=now()
          AND ("leaseUntil" IS NULL OR "leaseUntil"<now())
        ORDER BY CASE WHEN "eventType" IN ('delete','acl-change') THEN 0 ELSE 1 END, "createdAt" LIMIT $2 FOR UPDATE SKIP LOCKED
      ) UPDATE knowledge.outbox SET "leaseOwner"=$3,"leaseUntil"=now()+interval '5 minutes',attempts=attempts+1,version=version+1
      WHERE id IN (SELECT id FROM claimable) RETURNING id,"sourceId" AS "sourceId","entityType" AS "entityType","entityId" AS "entityId","sourceVersion" AS "sourceVersion","eventType" AS "eventType",payload`,
      [principal.companyId, Math.min(Math.max(limit, 1), 100), workerId]
    );
    return result.rows;
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
