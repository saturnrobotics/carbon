import type { KyselyDatabase } from "@carbon/database/client";
import { type Kysely, sql } from "kysely";

/**
 * Consumer side of Carbon's knowledge source outbox
 * (`knowledgeSourceOutbox`, migration `knowledge-source-outbox`).
 *
 * Rows are written only by the reviewed source-table triggers, in the same
 * transaction as the business change. This module claims pending rows with a
 * lease and acknowledges them — the same semantics as the knowledge worker's
 * `packages/knowledge/src/indexing/outbox.server.ts`, so a Carbon event can be
 * carried into the knowledge outbox without translating its delivery state.
 *
 * Every function takes the database client (or an open transaction) from its
 * caller; nothing here constructs a pool.
 */

export const KNOWLEDGE_EVENT_LEASE_MINUTES = 5;
export const KNOWLEDGE_EVENT_CLAIM_LIMIT = 100;

export type KnowledgeSourceEntityType =
  | "receipt"
  | "receiptLine"
  | "item"
  | "purchaseOrder";
export type KnowledgeSourceEventType = "upsert" | "delete" | "acl-change";

export type KnowledgeSourceEvent = {
  source: "carbon";
  entityType: KnowledgeSourceEntityType;
  entityId: string;
  sourceVersion: string;
  eventType: KnowledgeSourceEventType;
};

export type ClaimedKnowledgeEvent = KnowledgeSourceEvent & {
  id: string;
  companyId: string;
  /** References only (for example a line's `receiptId`); never a body. */
  payload: unknown;
  attempts: number;
  leaseExpiresAt: string;
};

type Db = Kysely<KyselyDatabase>;

/** The same identity the knowledge outbox dedupes on (`outboxDedupeKey`). */
export function knowledgeEventDedupeKey(event: KnowledgeSourceEvent): string {
  return [
    event.source,
    event.entityType,
    event.entityId,
    event.sourceVersion,
    event.eventType
  ].join(":");
}

/**
 * Lease up to `limit` pending events for one company to `workerId`.
 *
 * Deletions and ACL changes are claimed before upserts; within a class, the
 * longest-available event first. A row whose lease has expired is claimable
 * again — its previous holder can no longer acknowledge it. Rows another
 * transaction is claiming right now are skipped, never waited on.
 */
export async function claimPendingKnowledgeEvents(
  db: Db,
  companyId: string,
  limit: number,
  lease: { workerId: string; leaseMinutes?: number }
): Promise<ClaimedKnowledgeEvent[]> {
  const bounded = Math.min(
    Math.max(Math.trunc(limit), 1),
    KNOWLEDGE_EVENT_CLAIM_LIMIT
  );
  const minutes = lease.leaseMinutes ?? KNOWLEDGE_EVENT_LEASE_MINUTES;
  if (!lease.workerId) throw new Error("A knowledge worker id is required");

  // Tombstones and ACL changes before upserts; within a class, the longest
  // available first. The same key selects the rows and orders the result.
  const priority = sql`CASE WHEN "eventType" IN ('delete', 'acl-change') THEN 0 ELSE 1 END`;
  const claim = async (trx: Db) => {
    const claimed = await trx
      .with("claimable", (qb) =>
        qb
          .selectFrom("knowledgeSourceOutbox")
          .select("id")
          .where("companyId", "=", companyId)
          .where("deliveredAt", "is", null)
          .where("availableAt", "<=", sql<string>`now()`)
          .where((eb) =>
            eb.or([
              eb("leaseExpiresAt", "is", null),
              eb("leaseExpiresAt", "<", sql<string>`now()`)
            ])
          )
          .orderBy(priority)
          .orderBy("availableAt")
          .orderBy("createdAt")
          .orderBy("id")
          .limit(bounded)
          .forUpdate()
          .skipLocked()
      )
      .updateTable("knowledgeSourceOutbox")
      .set({
        leaseOwner: lease.workerId,
        claimedAt: sql`now()`,
        leaseExpiresAt: sql`now() + make_interval(mins => ${minutes})`,
        attempts: sql`"attempts" + 1`,
        updatedAt: sql`now()`
      })
      .where("companyId", "=", companyId)
      .where("id", "in", (eb) => eb.selectFrom("claimable").select("id"))
      .returning("id")
      .execute();
    if (claimed.length === 0) return [];
    // RETURNING has no order; read the leased rows back in claim order.
    return await trx
      .selectFrom("knowledgeSourceOutbox")
      .select([
        "id",
        "companyId",
        "source",
        "entityType",
        "entityId",
        "sourceVersion",
        "eventType",
        "payload",
        "attempts",
        sql<string>`"leaseExpiresAt"::text`.as("leaseExpiresAt")
      ])
      .where("companyId", "=", companyId)
      .where(
        "id",
        "in",
        claimed.map((row) => row.id)
      )
      .orderBy(priority)
      .orderBy("availableAt")
      .orderBy("createdAt")
      .orderBy("id")
      .execute();
  };

  const rows = db.isTransaction
    ? await claim(db)
    : await db.transaction().execute(claim);
  return rows.map((row) => ({
    ...row,
    source: "carbon",
    entityType: row.entityType as KnowledgeSourceEntityType,
    eventType: row.eventType as KnowledgeSourceEventType
  }));
}

/**
 * Mark one leased event delivered. Call it only after the consumer's own
 * write has committed — or inside that transaction, so the two settle together.
 * A lease that expired or moved to another worker cannot acknowledge: the row
 * is (or will be) redelivered, and this throws rather than lying.
 */
export async function acknowledgeKnowledgeEvent(
  db: Db,
  ack: { companyId: string; eventId: string; workerId: string }
): Promise<void> {
  const result = await db
    .updateTable("knowledgeSourceOutbox")
    .set({
      deliveredAt: sql`now()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`
    })
    .where("companyId", "=", ack.companyId)
    .where("id", "=", ack.eventId)
    .where("deliveredAt", "is", null)
    .where("leaseOwner", "=", ack.workerId)
    .where("leaseExpiresAt", ">", sql<string>`now()`)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) {
    throw new Error(
      "knowledge outbox lease was lost before acknowledgement; the event will be redelivered"
    );
  }
}
