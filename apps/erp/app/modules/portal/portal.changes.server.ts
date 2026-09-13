import type { KyselyDatabase } from "@carbon/database/client";
import {
  CARBON_ENTITY_TYPES,
  type CarbonEntityType,
  projectCarbonItem,
  projectCarbonPurchaseOrder,
  projectCarbonReceipt
} from "@carbon/portal/sources/carbon.server";
import type { SourceChange } from "@carbon/portal/sources/contract";
import { now } from "@internationalized/date";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import {
  type ClaimedPortalEvent,
  claimPendingPortalEvents,
  PORTAL_EVENT_CLAIM_LIMIT
} from "./portal.events.server";

/**
 * The source-changes surface the portal worker pulls from Carbon.
 *
 * Not a `*.service.ts`: nothing here is an employee operation, so it is kept
 * out of the generated operation manifest and reachable only through the
 * machine-authorized `api/v1/portal/source-changes` route. Every reader is
 * scoped by `companyId` explicitly — the Kysely client sees no RLS — and every
 * projection is the same bounded identity/status shape the employee reads
 * return, produced by the shared projection functions so a worker never learns
 * a field an employee could not.
 */

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._/-]+$/);
const workerId = z.string().trim().min(1).max(128);
export const sourceChangesRequestValidator = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("claim"),
      sourceId: identifier,
      workerId,
      limit: z.number().int().min(1).max(PORTAL_EVENT_CLAIM_LIMIT)
    })
    .strict(),
  z
    .object({
      action: z.literal("acknowledge"),
      sourceId: identifier,
      workerId,
      eventIds: z.array(identifier).min(1).max(PORTAL_EVENT_CLAIM_LIMIT)
    })
    .strict(),
  z
    .object({
      action: z.literal("versions"),
      sourceId: identifier,
      entityType: z.enum(CARBON_ENTITY_TYPES),
      cursor: identifier.optional(),
      limit: z.number().int().min(1).max(100)
    })
    .strict(),
  z
    .object({
      action: z.literal("projections"),
      sourceId: identifier,
      entityType: z.enum(CARBON_ENTITY_TYPES),
      entityIds: z.array(identifier).min(1).max(100)
    })
    .strict()
]);
export type SourceChangesRequest = z.infer<
  typeof sourceChangesRequestValidator
>;

type Db = Kysely<KyselyDatabase>;

/**
 * The version a reader can see on the row itself, in the exact text form the
 * outbox trigger records (`portal-source-outbox` migration), so a sweep
 * comparing this against a stored projection revision compares like for like.
 */
const rowVersion = sql<string>`to_char(COALESCE("updatedAt","createdAt") AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const isoText = (column: string) =>
  sql<string | null>`${sql.ref(column)}::text`;

async function readItems(db: Db, companyId: string, ids: readonly string[]) {
  if (!ids.length) return [];
  return await db
    .selectFrom("item")
    .select([
      "id",
      "readableId",
      "readableIdWithRevision",
      "name",
      "description",
      "type",
      "revision",
      "revisionStatus",
      "mpn",
      "unitOfMeasureCode",
      "active",
      isoText("updatedAt").as("updatedAt"),
      rowVersion.as("sourceVersion")
    ])
    .where("companyId", "=", companyId)
    .where("id", "in", [...ids])
    .execute();
}

async function readReceipts(db: Db, companyId: string, ids: readonly string[]) {
  if (!ids.length) return [];
  return await db
    .selectFrom("receipt")
    .select([
      "id",
      "receiptId",
      isoText("postingDate").as("postingDate"),
      "status",
      "sourceDocument",
      "sourceDocumentId",
      "sourceDocumentReadableId",
      "supplierId",
      "locationId",
      isoText("updatedAt").as("updatedAt"),
      rowVersion.as("sourceVersion")
    ])
    .where("companyId", "=", companyId)
    .where("status", "=", "Posted")
    .where("postingDate", "is not", null)
    .where("id", "in", [...ids])
    .execute();
}

async function readPurchaseOrders(
  db: Db,
  companyId: string,
  ids: readonly string[]
) {
  if (!ids.length) return [];
  return await db
    .selectFrom("purchaseOrder")
    .select([
      "id",
      "purchaseOrderId",
      "revisionId",
      "status",
      isoText("orderDate").as("orderDate"),
      "supplierId",
      "supplierReference",
      isoText("closedAt").as("closedAt"),
      isoText("updatedAt").as("updatedAt"),
      rowVersion.as("sourceVersion")
    ])
    .where("companyId", "=", companyId)
    .where("id", "in", [...ids])
    .execute();
}

type Projected = NonNullable<SourceChange["entity"]>;

async function projectEntities(
  db: Db,
  companyId: string,
  entityType: CarbonEntityType,
  ids: readonly string[]
): Promise<Map<string, Projected>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Projected>();
  if (entityType === "item") {
    for (const row of await readItems(db, companyId, unique))
      out.set(
        row.id,
        projectCarbonItem(
          {
            ...row,
            type: row.type as string,
            revisionStatus: row.revisionStatus as string
          },
          row.sourceVersion
        )
      );
  } else if (entityType === "receipt") {
    for (const row of await readReceipts(db, companyId, unique))
      out.set(
        row.id,
        projectCarbonReceipt(
          {
            ...row,
            status: row.status as string,
            sourceDocument: row.sourceDocument as string | null
          },
          row.sourceVersion
        )
      );
  } else {
    for (const row of await readPurchaseOrders(db, companyId, unique))
      out.set(
        row.id,
        projectCarbonPurchaseOrder(
          {
            ...row,
            status: row.status as string,
            supplierReference: row.supplierReference ?? null
          },
          row.sourceVersion
        )
      );
  }
  return out;
}

function receiptIdOf(event: ClaimedPortalEvent): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const value = (payload as Record<string, unknown>).receiptId;
  return typeof value === "string" && value ? value : null;
}

/**
 * Lease up to `limit` outbox events and attach what Carbon shows for each
 * entity NOW. A line event lands on its receipt: the receipt projection is
 * re-read and the receipt is the change's target. An upsert whose row is no
 * longer visible (unposted, deleted) carries no entity and is a tombstone for
 * the consumer. Reads are batched per entity type; no event issues its own.
 */
export async function claimPortalSourceChanges(
  db: Db,
  input: { companyId: string; workerId: string; limit: number }
) {
  const observedAt = now("UTC").toAbsoluteString();
  const events = await claimPendingPortalEvents(
    db,
    input.companyId,
    input.limit,
    { workerId: input.workerId }
  );
  const wanted: Record<CarbonEntityType, string[]> = {
    item: [],
    receipt: [],
    purchaseOrder: []
  };
  const lineReceipts = new Map<string, string>();
  const unresolvedLines: string[] = [];
  for (const event of events) {
    if (event.eventType === "delete" && event.entityType !== "receiptLine")
      continue;
    if (event.entityType === "receiptLine") {
      const receiptId = receiptIdOf(event);
      if (receiptId) {
        lineReceipts.set(event.id, receiptId);
        wanted.receipt.push(receiptId);
      } else unresolvedLines.push(event.entityId);
      continue;
    }
    wanted[event.entityType].push(event.entityId);
  }
  if (unresolvedLines.length) {
    const lines = await db
      .selectFrom("receiptLine")
      .select(["id", "receiptId"])
      .where("companyId", "=", input.companyId)
      .where("id", "in", unresolvedLines)
      .execute();
    const byLine = new Map(lines.map((line) => [line.id, line.receiptId]));
    for (const event of events) {
      if (event.entityType !== "receiptLine" || lineReceipts.has(event.id))
        continue;
      const receiptId = byLine.get(event.entityId);
      if (receiptId) {
        lineReceipts.set(event.id, receiptId);
        wanted.receipt.push(receiptId);
      }
    }
  }
  const [items, receipts, purchaseOrders] = await Promise.all([
    projectEntities(db, input.companyId, "item", wanted.item),
    projectEntities(db, input.companyId, "receipt", wanted.receipt),
    projectEntities(db, input.companyId, "purchaseOrder", wanted.purchaseOrder)
  ]);
  const changes: SourceChange[] = events.map((event) => {
    const base = {
      id: event.id,
      entityType: event.entityType,
      entityId: event.entityId,
      sourceVersion: event.sourceVersion,
      eventType: event.eventType,
      observedAt
    };
    if (event.entityType === "receiptLine") {
      const receiptId = lineReceipts.get(event.id);
      if (!receiptId)
        // The line and its receipt are both gone; nothing is indexed under it.
        return { ...base, entity: null };
      return {
        ...base,
        target: { entityType: "receipt", entityId: receiptId },
        entity: receipts.get(receiptId) ?? null
      };
    }
    if (event.eventType === "delete") return { ...base, entity: null };
    const projection =
      event.entityType === "item"
        ? items.get(event.entityId)
        : event.entityType === "receipt"
          ? receipts.get(event.entityId)
          : purchaseOrders.get(event.entityId);
    return { ...base, entity: projection ?? null };
  });
  return {
    items: changes,
    observedAt,
    sourceRevision: `carbon:${input.companyId}:${observedAt}`,
    status: "complete" as const,
    ...(events[0] ? { leaseExpiresAt: leaseIso(events[0].leaseExpiresAt) } : {})
  };
}

function leaseIso(value: string): string {
  // Postgres `timestamptz::text` is `YYYY-MM-DD HH:MI:SS.US+00`; the contract
  // wants RFC 3339 with an offset.
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(
      value
    );
  if (!match) return value;
  return `${match[1]}T${match[2]}${match[3]}:${match[4] ?? "00"}`;
}

/**
 * Mark leased events delivered in one statement. Only rows this worker still
 * holds a live lease on are acknowledged; the returned ids say which. A lost
 * lease is not an error here — the event is redelivered and the projection is
 * idempotent — but it is never reported as acknowledged either.
 */
export async function acknowledgePortalSourceChanges(
  db: Db,
  input: { companyId: string; workerId: string; eventIds: readonly string[] }
): Promise<{ acknowledged: string[] }> {
  if (!input.eventIds.length) return { acknowledged: [] };
  const rows = await db
    .updateTable("portalSourceOutbox")
    .set({
      deliveredAt: sql`now()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`
    })
    .where("companyId", "=", input.companyId)
    .where("id", "in", [...input.eventIds])
    .where("deliveredAt", "is", null)
    .where("leaseOwner", "=", input.workerId)
    .where("leaseExpiresAt", ">", sql<string>`now()`)
    .returning("id")
    .execute();
  return { acknowledged: rows.map((row) => row.id) };
}

/**
 * One keyset page of `(entityId, sourceVersion)` for one entity type, in byte
 * order (`COLLATE "C"`) so the consumer's range arithmetic matches regardless
 * of either database's locale. Lists only rows a reader can see — the same
 * visibility the projections and the outbox trigger apply.
 */
export async function listPortalSourceEntityVersions(
  db: Db,
  input: {
    companyId: string;
    entityType: CarbonEntityType;
    cursor?: string;
    limit: number;
  }
) {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
  const observedAt = now("UTC").toAbsoluteString();
  const table =
    input.entityType === "item"
      ? sql.table("item")
      : input.entityType === "receipt"
        ? sql.table("receipt")
        : sql.table("purchaseOrder");
  const visibility =
    input.entityType === "receipt"
      ? sql`AND "status"='Posted' AND "postingDate" IS NOT NULL`
      : sql``;
  const after = input.cursor
    ? sql`AND "id" COLLATE "C" > ${input.cursor}`
    : sql``;
  const result = await sql<{ entityId: string; sourceVersion: string }>`
    SELECT "id" AS "entityId", ${rowVersion} AS "sourceVersion"
    FROM ${table}
    WHERE "companyId" = ${input.companyId} ${visibility} ${after}
    ORDER BY "id" COLLATE "C"
    LIMIT ${limit + 1}
  `.execute(db);
  const page = result.rows.slice(0, limit);
  const more = result.rows.length > limit;
  const last = page.at(-1);
  return {
    items: page,
    ...(more && last ? { nextCursor: last.entityId } : {}),
    observedAt,
    sourceRevision: `carbon:${input.companyId}:${input.entityType}:${observedAt}`,
    status: more ? ("partial" as const) : ("complete" as const),
    ...(more ? { incompleteReason: "more-rows-behind-cursor" } : {})
  };
}

/** Batched current projections for a reconciliation sweep's stale ids. */
export async function getPortalSourceEntityProjections(
  db: Db,
  input: {
    companyId: string;
    entityType: CarbonEntityType;
    entityIds: readonly string[];
  }
) {
  const observedAt = now("UTC").toAbsoluteString();
  const projected = await projectEntities(
    db,
    input.companyId,
    input.entityType,
    input.entityIds.slice(0, 100)
  );
  return {
    items: [...projected.values()],
    observedAt,
    sourceRevision: `carbon:${input.companyId}:${input.entityType}:${observedAt}`,
    status: "complete" as const
  };
}

/** The portal source row this feed serves must exist, be Carbon, and be active. */
export async function isActiveCarbonPortalSource(
  db: Db,
  companyId: string,
  sourceId: string
): Promise<boolean> {
  const result = await sql<{ id: string }>`
    SELECT id FROM portal.source
    WHERE "companyId" = ${companyId} AND id = ${sourceId} AND kind = 'carbon' AND status = 'active'
    LIMIT 1
  `.execute(db);
  return result.rows.length === 1;
}
