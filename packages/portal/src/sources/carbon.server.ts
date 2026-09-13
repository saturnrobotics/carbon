import { createHash } from "node:crypto";
import { now, parseAbsolute } from "@internationalized/date";
import type { Pool } from "pg";
import { z } from "zod";
import {
  type DatabasePrincipal,
  withPortalTransaction
} from "../database.server";
import {
  type ChangePage,
  changePageSchema,
  documentReferencePageSchema,
  type EntityVersionPage,
  entityPageSchema,
  entityVersionPageSchema,
  factQuerySchema,
  itemSchema,
  receiptIdentitySchema,
  type SourceChange,
  type SourceOutcome,
  sourceEntitySchema,
  sourceSearchSchema
} from "./contract";
import {
  createMachineSourceTransport,
  createSourceTransport,
  type MachineSourceRequestContext,
  type SourceConnection,
  type SourceRequestContext
} from "./http.server";
import { factValidUntil, outcomeFromError } from "./outcome";

/**
 * Carbon as a portal source.
 *
 * Two adapters share one connection. The read adapter answers the finite
 * source contract on behalf of a verified employee through Carbon's canonical
 * portal reads (parts, receipts, purchase status), so every row is one the
 * caller's own Carbon permission returned. The change feed is machine-only:
 * it leases Carbon's `portalSourceOutbox` through the source-changes
 * route, never a database connection, and `persistCarbonChangePage` projects
 * what it observed into `portal.entity` and the portal outbox.
 */

export const CARBON_SOURCE_CHANGES_PATH = "/api/v1/portal/source-changes";
export const CARBON_ENTITY_TYPES = [
  "item",
  "receipt",
  "purchaseOrder"
] as const;
export type CarbonEntityType = (typeof CARBON_ENTITY_TYPES)[number];
/** Carbon source table → the `portal.entity.entityType` its projection lands on. */
export const CARBON_PORTAL_ENTITY_TYPES: Record<
  CarbonEntityType,
  "part" | "receipt" | "purchase-order"
> = { item: "part", receipt: "receipt", purchaseOrder: "purchase-order" };

type SourceEntity = z.infer<typeof sourceEntitySchema>;
type SourceEntityPage = z.infer<typeof entityPageSchema>;
type Fact = { label: string; value: string };

const CARBON_LINKS: Record<string, (id: string) => string> = {
  part: (id) => `/x/part/${encodeURIComponent(id)}`,
  receipt: (id) => `/x/receipt/${encodeURIComponent(id)}`,
  "purchase-order": (id) => `/x/purchase-order/${encodeURIComponent(id)}`
};

/** The owning application's authenticated page for an entity; Carbon authorizes on open. */
export function carbonDeepLink(
  origin: string,
  type: string,
  id: string
): string | undefined {
  const path = CARBON_LINKS[type];
  return path ? new URL(path(id), origin).toString() : undefined;
}

function withLink(origin: string, entity: SourceEntity): SourceEntity {
  const link = carbonDeepLink(origin, entity.type, entity.id);
  return link ? { ...entity, fields: { ...entity.fields, link } } : entity;
}

/** Carbon's search validator admits letters, digits, space and `. _ / -`. */
export function carbonSearchTerm(query: string): string {
  return query
    .replace(/[^\p{L}\p{N} ._/-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function projectionRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A Carbon item as the finite source entity; price and cost fields never exist here. */
export function projectCarbonItem(
  item: z.infer<typeof itemSchema> & {
    readableIdWithRevision?: string | null;
    revisionStatus?: string | null;
    type?: string | null;
    unitOfMeasureCode?: string | null;
    active?: boolean | null;
    updatedAt?: string | null;
  },
  sourceVersion?: string
): SourceEntity {
  return sourceEntitySchema.parse({
    id: item.id,
    type: "part",
    title: item.name || item.readableId || item.id,
    ...(item.description
      ? { description: item.description.slice(0, 8000) }
      : {}),
    revision: sourceVersion ?? projectionRevision(item),
    fields: {
      readableId: item.readableId,
      readableIdWithRevision: item.readableIdWithRevision ?? null,
      revision: item.revision,
      revisionStatus: item.revisionStatus ?? null,
      mpn: item.mpn,
      itemType: item.type ?? null,
      unitOfMeasureCode: item.unitOfMeasureCode ?? null,
      active: item.active ?? null,
      updatedAt: item.updatedAt ?? null
    }
  });
}

export const purchaseProjectionSchema = z.object({
  id: z.string().min(1).max(256),
  purchaseOrderId: z.string().max(256),
  status: z.string().max(100),
  orderDate: z.string().max(40).nullable(),
  updatedAt: z.string().max(40).nullable(),
  revisionId: z
    .union([z.string().max(256), z.number().int()])
    .nullable()
    .optional(),
  supplierId: z.string().max(256).nullable().optional(),
  supplierReference: z.string().max(256).nullable().optional(),
  closedAt: z.string().max(40).nullable().optional()
});

export function projectCarbonPurchaseOrder(
  purchase: z.infer<typeof purchaseProjectionSchema>,
  sourceVersion?: string
): SourceEntity {
  return sourceEntitySchema.parse({
    id: purchase.id,
    type: "purchase-order",
    title: `Purchase order ${purchase.purchaseOrderId || purchase.id}`,
    revision: sourceVersion ?? projectionRevision(purchase),
    fields: {
      purchaseOrderId: purchase.purchaseOrderId,
      status: purchase.status,
      orderDate: purchase.orderDate,
      revisionId:
        purchase.revisionId === undefined || purchase.revisionId === null
          ? null
          : String(purchase.revisionId),
      supplierId: purchase.supplierId ?? null,
      supplierReference: purchase.supplierReference ?? null,
      closedAt: purchase.closedAt ?? null,
      updatedAt: purchase.updatedAt
    }
  });
}

export const receiptProjectionSchema = z.object({
  id: z.string().min(1).max(256),
  receiptId: z.string().max(256).nullable(),
  postingDate: z.string().max(40).nullable(),
  status: z.string().max(100),
  sourceDocument: z.string().max(100).nullable(),
  sourceDocumentId: z.string().max(256).nullable(),
  sourceDocumentReadableId: z.string().max(256).nullable(),
  supplierId: z.string().max(256).nullable(),
  locationId: z.string().max(256).nullable(),
  updatedAt: z.string().max(64).nullable()
});

/** A posted receipt header; quantities live on the ledger-backed receipt reads. */
export function projectCarbonReceipt(
  receipt: z.infer<typeof receiptProjectionSchema>,
  sourceVersion?: string
): SourceEntity {
  return sourceEntitySchema.parse({
    id: receipt.id,
    type: "receipt",
    title: receipt.receiptId ? `Receipt ${receipt.receiptId}` : receipt.id,
    revision: sourceVersion ?? projectionRevision(receipt),
    fields: {
      receiptId: receipt.receiptId,
      postingDate: receipt.postingDate,
      status: receipt.status,
      sourceDocument: receipt.sourceDocument,
      sourceDocumentId: receipt.sourceDocumentId,
      sourceDocumentReadableId: receipt.sourceDocumentReadableId,
      supplierId: receipt.supplierId,
      locationId: receipt.locationId,
      updatedAt: receipt.updatedAt
    }
  });
}

const documentReferenceRowSchema = z.object({
  name: z.string().max(1024),
  objectKey: z.string().min(1).max(1024),
  updatedAt: z.string().max(64).nullable().optional()
});

/** What Carbon's `portalIdentifier` validator admits; refused before the call. */
const CARBON_IDENTIFIER = /^[A-Za-z0-9._/-]{1,256}$/;

/**
 * The workforce capability Carbon requires for the supplier pricing operation
 * (`PORTAL_OPERATIONS`, apps/erp/app/modules/portal/portal.server.ts).
 * Carbon's gate remains the authority; reading it here can only refuse.
 */
export const CARBON_PRICING_CAPABILITY = "portal.read.pricing";

/** Carbon returns at most this many supplier prices for one item. */
const SUPPLIER_PRICING_LIMIT = 50;

/**
 * One supplier's agreed price for an item — the ONLY money Carbon discloses to
 * this platform, and the reason it is a separate operation with a separate
 * capability. It is deliberately not a `sourceEntity`: the finite source
 * contract is money-free, and `sourceEntitySchema` is what keeps the item,
 * receipt and purchase-order projections that way.
 */
export const supplierPriceSchema = z.object({
  supplierId: z.string().min(1).max(256),
  supplierUnitPrice: z.number().finite().nullable(),
  currencyCode: z.string().max(10).nullable(),
  unitOfMeasureCode: z.string().max(100).nullable(),
  updatedAt: z.string().max(64).nullable()
});
export type SupplierPrice = z.infer<typeof supplierPriceSchema>;

function bounded<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++] as T;
        await operation(item);
      }
    }
  );
  return Promise.all(workers).then(() => undefined);
}

/**
 * The employee-facing read adapter. Every method maps a transport failure to a
 * structured outcome rather than an empty page, so an outage is never rendered
 * as "nothing found", and a denial is never rendered as "does not exist".
 */
export function createCarbonSourceAdapter(
  connection: SourceConnection,
  context: SourceRequestContext
) {
  const transport = createSourceTransport(connection, context);
  const origin = connection.origin;
  const principal = context.identity.principal;

  async function readItem(itemId: string) {
    if (!CARBON_IDENTIFIER.test(itemId))
      throw Error("Invalid entity identifier");
    return itemSchema
      .extend({
        readableIdWithRevision: z.string().max(256).nullable().optional(),
        revisionStatus: z.string().max(100).nullable().optional(),
        type: z.string().max(100).nullable().optional(),
        unitOfMeasureCode: z.string().max(100).nullable().optional(),
        active: z.boolean().nullable().optional(),
        updatedAt: z.string().max(64).nullable().optional()
      })
      .nullable()
      .parse(
        await transport.post("/api/v1/portal/getItemIdentity", { itemId })
      );
  }

  return {
    kind: "carbon" as const,
    async searchEntities(
      input: unknown
    ): Promise<{ outcome: SourceOutcome; page: SourceEntityPage | null }> {
      const search = sourceSearchSchema.parse(input);
      const term = carbonSearchTerm(search.query);
      if (!term) throw Error("Invalid search");
      const observedAt = now("UTC").toAbsoluteString();
      try {
        const result = await transport.post("/api/v1/portal/resolveItems", {
          search: term,
          limit: search.limit
        });
        const rows = z
          .array(
            itemSchema.extend({
              readableIdWithRevision: z.string().max(256).nullable().optional(),
              revisionStatus: z.string().max(100).nullable().optional(),
              type: z.string().max(100).nullable().optional(),
              unitOfMeasureCode: z.string().max(100).nullable().optional(),
              active: z.boolean().nullable().optional(),
              updatedAt: z.string().max(64).nullable().optional()
            })
          )
          .max(100)
          .parse(
            typeof result === "object" && result !== null && "results" in result
              ? (result as { results: unknown }).results
              : result
          );
        const items = rows
          .slice(0, search.limit)
          .map((row) => withLink(origin, projectCarbonItem(row)));
        // Carbon's resolver has no cursor; a full page means the bound cut the
        // result, which the caller must treat as "narrow the search", not "all".
        const truncated = rows.length >= search.limit;
        const page = entityPageSchema.parse({
          items,
          observedAt,
          sourceRevision: `carbon:${projectionRevision(items.map((item) => [item.id, item.revision]))}`,
          status: truncated ? "partial" : "complete",
          ...(truncated ? { incompleteReason: "bounded-result-truncated" } : {})
        });
        return { outcome: { kind: "ok" }, page };
      } catch (error) {
        return { outcome: outcomeFromError(error), page: null };
      }
    },
    async getEntity(id: string): Promise<{
      outcome: SourceOutcome;
      entity: SourceEntity | null;
      observedAt: string;
    }> {
      const observedAt = now("UTC").toAbsoluteString();
      try {
        const item = await readItem(id);
        if (!item)
          return { outcome: { kind: "not-found" }, entity: null, observedAt };
        return {
          outcome: { kind: "ok" },
          entity: withLink(origin, projectCarbonItem(item)),
          observedAt
        };
      } catch (error) {
        return { outcome: outcomeFromError(error), entity: null, observedAt };
      }
    },
    async queryFacts(input: unknown): Promise<{
      outcome: SourceOutcome;
      facts: {
        entityId: string;
        sourceRevision: string;
        observedAt: string;
        validUntil: string;
        facts: Fact[];
      } | null;
      status: "complete" | "partial";
    }> {
      const query = factQuerySchema.parse(input);
      const observedAt = now("UTC").toAbsoluteString();
      const validUntil = factValidUntil(observedAt);
      try {
        if (query.fact === "contact-summary")
          return {
            outcome: { kind: "unavailable", reason: "unsupported" },
            facts: null,
            status: "complete"
          };
        if (query.fact === "status") {
          const purchase = purchaseProjectionSchema.nullable().parse(
            await transport.post("/api/v1/portal/getPurchaseStatus", {
              purchaseOrderId: query.entityId
            })
          );
          if (purchase)
            return {
              outcome: { kind: "ok" },
              status: "complete",
              facts: {
                entityId: purchase.id,
                sourceRevision: projectionRevision(purchase),
                observedAt,
                validUntil,
                facts: [
                  { label: "Status", value: purchase.status },
                  { label: "Order date", value: purchase.orderDate ?? "" },
                  { label: "Closed at", value: purchase.closedAt ?? "" }
                ]
              }
            };
        }
        if (query.fact === "availability") {
          const receipts = z
            .object({
              items: z.array(receiptIdentitySchema).max(100),
              status: z.enum(["complete", "partial"]),
              incompleteReason: z.string().max(1000).optional()
            })
            .parse(
              await transport.post("/api/v1/portal/getRecentReceiptItems", {
                itemIds: [query.entityId],
                limit: 40
              })
            );
          const posted = receipts.items
            .filter((row) => row.posted && !row.voided)
            .sort((a, b) =>
              parseAbsolute(b.receivedAt, "UTC").compare(
                parseAbsolute(a.receivedAt, "UTC")
              )
            );
          const latest = posted[0];
          return {
            outcome: { kind: "ok" },
            status: receipts.status,
            facts: {
              entityId: query.entityId,
              sourceRevision: projectionRevision(receipts.items),
              observedAt,
              validUntil,
              facts: [
                {
                  label: "Last posted receipt",
                  value: latest ? latest.receivedAt.slice(0, 10) : ""
                },
                {
                  label: "Received quantity",
                  value: latest?.quantity ?? "0"
                },
                {
                  label: "Reversed quantity",
                  value: latest?.reversedQuantity ?? "0"
                },
                {
                  label: "Posted receipts considered",
                  value: `${posted.length}`
                },
                ...(receipts.status === "partial"
                  ? [
                      {
                        label: "Completeness",
                        value: `partial: ${receipts.incompleteReason ?? "unknown"}`
                      }
                    ]
                  : [])
              ]
            }
          };
        }
        const item = await readItem(query.entityId);
        if (!item)
          return {
            outcome: { kind: "not-found" },
            facts: null,
            status: "complete"
          };
        return {
          outcome: { kind: "ok" },
          status: "complete",
          facts: {
            entityId: item.id,
            sourceRevision: projectionRevision(item),
            observedAt,
            validUntil,
            facts: [
              {
                label: "Item",
                value: item.readableIdWithRevision ?? item.readableId
              },
              { label: "Revision", value: item.revision ?? "" },
              { label: "Revision status", value: item.revisionStatus ?? "" },
              { label: "Active", value: item.active === false ? "no" : "yes" }
            ]
          }
        };
      } catch (error) {
        return {
          outcome: outcomeFromError(error),
          facts: null,
          status: "complete"
        };
      }
    },
    async getDocumentReferences(entityId: string) {
      if (!CARBON_IDENTIFIER.test(entityId))
        throw Error("Invalid entity identifier");
      const observedAt = now("UTC").toAbsoluteString();
      try {
        const result = await transport.post(
          "/api/v1/portal/getDocumentReferences",
          { itemId: entityId }
        );
        const rows = z
          .array(documentReferenceRowSchema)
          .max(100)
          .parse(
            typeof result === "object" && result !== null && "results" in result
              ? (result as { results: unknown }).results
              : (result ?? [])
          );
        const page = documentReferencePageSchema.parse({
          items: rows.slice(0, 40).map((row) => ({
            id: projectionRevision([entityId, row.objectKey]),
            entityId,
            documentVersionId: projectionRevision([
              row.objectKey,
              row.updatedAt
            ]),
            title: row.name.slice(0, 500),
            // A stored attachment is evidence of a document, not a verified
            // applicability link; those are human-verified `entityLink` rows.
            relation: "related",
            sourceRevision: row.updatedAt ?? "unknown"
          })),
          observedAt,
          sourceRevision: `carbon:${projectionRevision(rows)}`,
          status: rows.length > 40 ? "partial" : "complete",
          ...(rows.length > 40
            ? { incompleteReason: "bounded-result-truncated" }
            : {})
        });
        return { outcome: { kind: "ok" } satisfies SourceOutcome, page };
      } catch (error) {
        return { outcome: outcomeFromError(error), page: null };
      }
    },
    /**
     * The active supplier unit prices for one item, optionally for one
     * supplier. This is the one Carbon read that discloses money, which is why
     * it is a separate operation rather than fields on the item projection:
     * Carbon gates it on its own capability (`portal.read.pricing`) AND on
     * purchasing view, so the identity, receipt and purchase-order reads above
     * stay free of every price and cost field.
     *
     * The capability is re-read here before the call. The transport's blanket
     * `portal.read` check does not imply it, and a caller who never held it
     * should not spend a source read learning that. It can only refuse:
     * Carbon's gate is what grants, and a caller who passes this check still
     * receives `insufficient-permission` from Carbon without the purchasing
     * permission the supplierPart and supplier row-level policies require.
     */
    async getSupplierPricing(
      itemId: string,
      supplierId?: string
    ): Promise<{
      outcome: SourceOutcome;
      prices: SupplierPrice[] | null;
      observedAt: string;
      validUntil: string;
      sourceRevision: string | null;
      status: "complete" | "partial";
    }> {
      if (
        !CARBON_IDENTIFIER.test(itemId) ||
        (supplierId !== undefined && !CARBON_IDENTIFIER.test(supplierId))
      )
        throw Error("Invalid entity identifier");
      const observedAt = now("UTC").toAbsoluteString();
      const validUntil = factValidUntil(observedAt);
      const withoutPrices = {
        prices: null,
        observedAt,
        validUntil,
        sourceRevision: null,
        status: "complete" as const
      };
      if (!principal.capabilities.includes(CARBON_PRICING_CAPABILITY))
        return {
          outcome: { kind: "insufficient-permission" },
          ...withoutPrices
        };
      try {
        const result = await transport.post(
          "/api/v1/portal/getItemSupplierPricing",
          { itemId, ...(supplierId ? { supplierId } : {}) }
        );
        const rows = z
          .array(supplierPriceSchema)
          .max(100)
          .parse(
            typeof result === "object" && result !== null && "results" in result
              ? (result as { results: unknown }).results
              : (result ?? [])
          );
        // Carbon bounds the read; a full page means the bound cut it, which the
        // caller must read as "name the supplier", not "these are all of them".
        const truncated = rows.length >= SUPPLIER_PRICING_LIMIT;
        return {
          outcome: { kind: "ok" },
          prices: rows.slice(0, SUPPLIER_PRICING_LIMIT),
          observedAt,
          validUntil,
          sourceRevision: `carbon:${projectionRevision(rows)}`,
          status: truncated ? "partial" : "complete"
        };
      } catch (error) {
        return { outcome: outcomeFromError(error), ...withoutPrices };
      }
    },
    /**
     * Membership of the caller's Carbon view, one bounded parallel read per id.
     * Carbon exposes no batched identity read on this surface; the fan-out is
     * capped at the contract's 40 ids and 8 in flight.
     */
    async checkAccess(ids: string[]) {
      if (
        ids.length < 1 ||
        ids.length > 40 ||
        ids.some((id) => !CARBON_IDENTIFIER.test(id))
      )
        throw Error("Invalid access projection");
      const observedAt = now("UTC").toAbsoluteString();
      const allowed = new Set<string>();
      let outcome: SourceOutcome = { kind: "ok" };
      await bounded([...new Set(ids)], 8, async (id) => {
        try {
          if (await readItem(id)) allowed.add(id);
        } catch (error) {
          const failure = outcomeFromError(error);
          if (failure.kind !== "insufficient-permission") outcome = failure;
        }
      });
      return {
        outcome,
        result: {
          allowedIds: ids.filter((id) => allowed.has(id)),
          policyVersion: principal.policyVersion,
          validUntil: factValidUntil(observedAt)
        }
      };
    }
  };
}

export type CarbonSourceAdapter = ReturnType<typeof createCarbonSourceAdapter>;

const acknowledgeSchema = z
  .object({ acknowledged: z.array(z.string().min(1).max(256)).max(100) })
  .strict();

/**
 * The machine change feed over Carbon's source-changes route. Claims are
 * leases: a claimed change must be acknowledged before `leaseExpiresAt` or it
 * is redelivered, which is the at-least-once contract the projection below is
 * written to tolerate.
 */
export function createCarbonChangeFeed(
  connection: SourceConnection,
  context: MachineSourceRequestContext,
  options: { sourceId: string; workerId: string }
) {
  const transport = createMachineSourceTransport(connection, context);
  const origin = connection.origin;
  function decorate(page: ChangePage): ChangePage {
    return {
      ...page,
      items: page.items.map((change) =>
        change.entity
          ? { ...change, entity: withLink(origin, change.entity) }
          : change
      )
    };
  }
  return {
    async getChanges(input: { limit: number }): Promise<ChangePage> {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
      return decorate(
        changePageSchema.parse(
          await transport.post(CARBON_SOURCE_CHANGES_PATH, {
            sourceId: options.sourceId,
            action: "claim",
            workerId: options.workerId,
            limit
          })
        )
      );
    },
    async acknowledge(eventIds: readonly string[]): Promise<string[]> {
      if (!eventIds.length) return [];
      if (eventIds.length > 100) throw Error("Acknowledgement batch too large");
      return acknowledgeSchema.parse(
        await transport.post(CARBON_SOURCE_CHANGES_PATH, {
          sourceId: options.sourceId,
          action: "acknowledge",
          workerId: options.workerId,
          eventIds: [...eventIds]
        })
      ).acknowledged;
    },
    async listVersions(input: {
      entityType: CarbonEntityType;
      cursor?: string;
      limit: number;
    }): Promise<EntityVersionPage> {
      return entityVersionPageSchema.parse(
        await transport.post(CARBON_SOURCE_CHANGES_PATH, {
          sourceId: options.sourceId,
          action: "versions",
          entityType: input.entityType,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: Math.min(Math.max(Math.trunc(input.limit), 1), 100)
        })
      );
    },
    async getProjections(input: {
      entityType: CarbonEntityType;
      entityIds: readonly string[];
    }): Promise<SourceEntityPage> {
      if (!input.entityIds.length)
        return entityPageSchema.parse({
          items: [],
          observedAt: now("UTC").toAbsoluteString(),
          sourceRevision: "carbon:empty",
          status: "complete"
        });
      const page = entityPageSchema.parse(
        await transport.post(CARBON_SOURCE_CHANGES_PATH, {
          sourceId: options.sourceId,
          action: "projections",
          entityType: input.entityType,
          entityIds: [...input.entityIds].slice(0, 100)
        })
      );
      return {
        ...page,
        items: page.items.map((item) => withLink(origin, item))
      };
    }
  };
}

export type CarbonChangeFeed = ReturnType<typeof createCarbonChangeFeed>;

function exactIdentifiers(entity: SourceEntity): Record<string, string> {
  const keys =
    entity.type === "part"
      ? ["readableId", "readableIdWithRevision", "mpn", "revision"]
      : entity.type === "purchase-order"
        ? ["purchaseOrderId"]
        : entity.type === "receipt"
          ? ["receiptId", "sourceDocumentReadableId"]
          : [];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = entity.fields[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

function portalEntityTypeOf(type: string): string {
  return (
    (CARBON_PORTAL_ENTITY_TYPES as Record<string, string | undefined>)[type] ??
    type
  );
}

export type CarbonProjectionPlan = {
  upserts: Array<{
    sourceEntityId: string;
    entityType: string;
    sourceRevision: string;
    displayName: string;
    exactIdentifiers: Record<string, string>;
    metadata: Record<string, unknown>;
    observedAt: string;
  }>;
  tombstones: Array<{
    sourceEntityId: string;
    entityType: string;
    sourceVersion: string;
    observedAt: string;
  }>;
  aclChanges: Array<{
    sourceEntityId: string;
    entityType: string;
    sourceVersion: string;
  }>;
};

/**
 * Turns a claimed batch into an order-independent plan. The projection each
 * change carries is what Carbon showed at claim time, so applying any change
 * applies the newest observation: a delete followed by a stale upsert of the
 * same row collapses to whatever Carbon says NOW, and duplicates are no-ops.
 */
export function planCarbonChanges(
  changes: readonly SourceChange[]
): CarbonProjectionPlan {
  const upserts = new Map<string, CarbonProjectionPlan["upserts"][number]>();
  const tombstones = new Map<
    string,
    CarbonProjectionPlan["tombstones"][number]
  >();
  const aclChanges = new Map<
    string,
    CarbonProjectionPlan["aclChanges"][number]
  >();
  for (const change of changes) {
    // Tombstones and ACL changes address the INDEXED entity type: a Carbon
    // `item` row lands as a `part`, so a delete keyed on the source table
    // name could never cancel or be cancelled by that part's upsert.
    const target = {
      entityType: portalEntityTypeOf(
        change.target?.entityType ?? change.entityType
      ),
      entityId: change.target?.entityId ?? change.entityId
    };
    if (change.eventType === "acl-change") {
      aclChanges.set(`${target.entityType}:${target.entityId}`, {
        sourceEntityId: target.entityId,
        entityType: target.entityType,
        sourceVersion: change.sourceVersion
      });
    }
    if (change.entity) {
      const key = `${change.entity.type}:${change.entity.id}`;
      const existing = upserts.get(key);
      if (
        !existing ||
        parseAbsolute(change.observedAt, "UTC").compare(
          parseAbsolute(existing.observedAt, "UTC")
        ) >= 0
      )
        upserts.set(key, {
          sourceEntityId: change.entity.id,
          entityType: change.entity.type,
          sourceRevision: change.entity.revision,
          displayName: change.entity.title,
          exactIdentifiers: exactIdentifiers(change.entity),
          metadata: {
            ...change.entity.fields,
            ...(change.entity.description
              ? { description: change.entity.description }
              : {})
          },
          observedAt: change.observedAt
        });
      tombstones.delete(key);
      continue;
    }
    const key = `${target.entityType}:${target.entityId}`;
    if (upserts.has(key)) continue;
    tombstones.set(key, {
      sourceEntityId: target.entityId,
      entityType: target.entityType,
      sourceVersion: change.sourceVersion,
      observedAt: change.observedAt
    });
  }
  return {
    upserts: [...upserts.values()],
    tombstones: [...tombstones.values()],
    aclChanges: [...aclChanges.values()]
  };
}

/**
 * Writes one plan under the ingestion role in a single transaction. Entity
 * upserts advance only forward in observation time and only when something a
 * reader can see changed, so replays and reordered deliveries leave no extra
 * epoch bumps. Tombstones and ACL changes also enqueue portal outbox
 * invalidation events (`entityType: "entity"`), which the invalidation
 * consumer leases with priority; entity upserts bump the source content epoch
 * through the entity table's own trigger and need no outbox row.
 */
export async function persistCarbonChangePage(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    sourceId: string;
    automationUserId: string;
    plan: CarbonProjectionPlan;
  }
): Promise<{ upserted: number; tombstoned: number; invalidations: number }> {
  if (principal.actorId)
    throw new Error("Carbon projection requires a machine principal");
  if (
    input.plan.upserts.length > 100 ||
    input.plan.tombstones.length > 100 ||
    input.plan.aclChanges.length > 100
  )
    throw new Error("Carbon projection batch too large");
  return withPortalTransaction(pool, principal, "write", async (client) => {
    const source = await client.query(
      `SELECT 1 FROM portal.source WHERE "companyId"=$1 AND id=$2 AND kind='carbon' AND status='active'`,
      [principal.companyId, input.sourceId]
    );
    if (!source.rows[0]) throw new Error("Carbon source is not writable");
    let upserted = 0;
    if (input.plan.upserts.length) {
      const result = await client.query(
        `INSERT INTO portal.entity ("companyId","createdBy","sourceId","sourceEntityId","entityType","sourceRevision","displayName","exactIdentifiers",metadata,"observedAt")
         SELECT $1,$2,$3,e."sourceEntityId",e."entityType",e."sourceRevision",e."displayName",e."exactIdentifiers",e.metadata,e."observedAt"::timestamptz
         FROM jsonb_to_recordset($4::jsonb) AS e("sourceEntityId" text,"entityType" text,"sourceRevision" text,"displayName" text,"exactIdentifiers" jsonb,metadata jsonb,"observedAt" text)
         ON CONFLICT ("companyId","sourceId","entityType","sourceEntityId") DO UPDATE SET
           "sourceRevision"=EXCLUDED."sourceRevision","displayName"=EXCLUDED."displayName","exactIdentifiers"=EXCLUDED."exactIdentifiers",
           metadata=EXCLUDED.metadata,"observedAt"=EXCLUDED."observedAt","deletedAt"=NULL,"updatedBy"=$2,"updatedAt"=now(),version=entity.version+1
         WHERE entity."observedAt"<=EXCLUDED."observedAt" AND (
           entity."deletedAt" IS NOT NULL OR entity."sourceRevision" IS DISTINCT FROM EXCLUDED."sourceRevision"
           OR entity."displayName" IS DISTINCT FROM EXCLUDED."displayName" OR entity."exactIdentifiers" IS DISTINCT FROM EXCLUDED."exactIdentifiers"
           OR entity.metadata IS DISTINCT FROM EXCLUDED.metadata)`,
        [
          principal.companyId,
          input.automationUserId,
          input.sourceId,
          JSON.stringify(input.plan.upserts)
        ]
      );
      upserted = result.rowCount ?? 0;
    }
    let tombstoned = 0;
    let invalidations = 0;
    if (input.plan.tombstones.length) {
      const result = await client.query<{ id: string; sourceVersion: string }>(
        `WITH gone AS (
           UPDATE portal.entity e SET "deletedAt"=now(),"observedAt"=t."observedAt"::timestamptz,"updatedBy"=$2,"updatedAt"=now(),version=e.version+1
           FROM jsonb_to_recordset($4::jsonb) AS t("sourceEntityId" text,"entityType" text,"sourceVersion" text,"observedAt" text)
           WHERE e."companyId"=$1 AND e."sourceId"=$3 AND e."entityType"=t."entityType" AND e."sourceEntityId"=t."sourceEntityId"
             AND e."deletedAt" IS NULL AND e."observedAt"<=t."observedAt"::timestamptz
           RETURNING e.id,t."sourceVersion",e."entityType",e."sourceEntityId"
         ), queued AS (
           INSERT INTO portal.outbox ("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
           SELECT $1,$2,$3,'entity',gone.id,gone."sourceVersion",'delete',jsonb_build_object('sourceEntityType',gone."entityType",'sourceEntityId',gone."sourceEntityId")
           FROM gone
           ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO NOTHING
           RETURNING "entityId"
         ) SELECT gone.id,gone."sourceVersion" FROM gone`,
        [
          principal.companyId,
          input.automationUserId,
          input.sourceId,
          JSON.stringify(input.plan.tombstones)
        ]
      );
      tombstoned = result.rowCount ?? 0;
      invalidations += tombstoned;
    }
    if (input.plan.aclChanges.length) {
      const result = await client.query(
        `INSERT INTO portal.outbox ("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
         SELECT $1,$2,$3,'entity',e.id,a."sourceVersion",'acl-change',jsonb_build_object('sourceEntityType',e."entityType",'sourceEntityId',e."sourceEntityId")
         FROM jsonb_to_recordset($4::jsonb) AS a("sourceEntityId" text,"entityType" text,"sourceVersion" text)
         JOIN portal.entity e ON e."companyId"=$1 AND e."sourceId"=$3 AND e."entityType"=a."entityType" AND e."sourceEntityId"=a."sourceEntityId"
         ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO NOTHING`,
        [
          principal.companyId,
          input.automationUserId,
          input.sourceId,
          JSON.stringify(input.plan.aclChanges)
        ]
      );
      invalidations += result.rowCount ?? 0;
    }
    return { upserted, tombstoned, invalidations };
  });
}

export type CarbonSweepState = {
  entityType: CarbonEntityType;
  /** The last source entity id already reconciled (`COLLATE "C"` order). */
  afterId: string | null;
};

function readSweepState(value: unknown): CarbonSweepState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sweep = (value as Record<string, unknown>).carbonSweep;
  if (!sweep || typeof sweep !== "object" || Array.isArray(sweep)) return null;
  const record = sweep as Record<string, unknown>;
  const entityType = record.entityType;
  if (
    typeof entityType !== "string" ||
    !(CARBON_ENTITY_TYPES as readonly string[]).includes(entityType)
  )
    return null;
  return {
    entityType: entityType as CarbonEntityType,
    afterId: typeof record.afterId === "string" ? record.afterId : null
  };
}

export function nextSweepState(
  current: CarbonSweepState,
  page: { lastId: string | null; done: boolean }
): CarbonSweepState {
  if (!page.done)
    return { entityType: current.entityType, afterId: page.lastId };
  const index = CARBON_ENTITY_TYPES.indexOf(current.entityType);
  const next = CARBON_ENTITY_TYPES[(index + 1) % CARBON_ENTITY_TYPES.length]!;
  return { entityType: next, afterId: null };
}

export async function getCarbonSweepState(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string
): Promise<CarbonSweepState> {
  if (principal.actorId)
    throw new Error("Carbon reconciliation requires a machine principal");
  return withPortalTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<{ cursor: unknown }>(
      `SELECT cursor FROM portal.source WHERE "companyId"=$1 AND id=$2 AND kind='carbon' AND status='active'`,
      [principal.companyId, sourceId]
    );
    if (!result.rows[0])
      throw new Error("Carbon source is not available to this worker");
    return (
      readSweepState(result.rows[0].cursor) ?? {
        entityType: CARBON_ENTITY_TYPES[0],
        afterId: null
      }
    );
  });
}

/**
 * Reconciles one keyset range of one entity type against Carbon's current
 * versions — a merge join, not a mark-and-sweep. Both sides order ids in
 * `COLLATE "C"` (byte order), so the range `(afterId, lastId]` is the same set
 * on both databases regardless of locale. Returns the ids whose projection
 * must be refreshed; entities inside the range that Carbon no longer lists are
 * tombstoned here. Matching versions write nothing, so an idle sweep never
 * moves an epoch.
 */
export async function reconcileCarbonRange(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    sourceId: string;
    automationUserId: string;
    entityType: CarbonEntityType;
    portalEntityType: string;
    afterId: string | null;
    lastId: string | null;
    versions: ReadonlyArray<{ entityId: string; sourceVersion: string }>;
    observedAt: string;
    expected: CarbonSweepState;
    next: CarbonSweepState;
  }
): Promise<{ stale: string[]; tombstoned: number }> {
  if (principal.actorId)
    throw new Error("Carbon reconciliation requires a machine principal");
  if (input.versions.length > 100)
    throw new Error("Reconciliation page too large");
  return withPortalTransaction(pool, principal, "write", async (client) => {
    const source = await client.query<{ cursor: unknown }>(
      `SELECT cursor FROM portal.source WHERE "companyId"=$1 AND id=$2 AND kind='carbon' AND status='active' FOR UPDATE`,
      [principal.companyId, input.sourceId]
    );
    const stored = readSweepState(source.rows[0]?.cursor) ?? {
      entityType: CARBON_ENTITY_TYPES[0],
      afterId: null
    };
    if (
      !source.rows[0] ||
      stored.entityType !== input.expected.entityType ||
      stored.afterId !== input.expected.afterId
    )
      throw new Error(
        "Carbon sweep cursor changed; restart from the stored cursor"
      );
    const ids = input.versions.map((row) => row.entityId);
    const existing = await client.query<{
      sourceEntityId: string;
      sourceRevision: string;
      deletedAt: string | null;
    }>(
      `SELECT "sourceEntityId","sourceRevision","deletedAt"::text AS "deletedAt" FROM portal.entity
       WHERE "companyId"=$1 AND "sourceId"=$2 AND "entityType"=$3 AND "sourceEntityId"=ANY($4::text[])`,
      [principal.companyId, input.sourceId, input.portalEntityType, ids]
    );
    const byId = new Map(existing.rows.map((row) => [row.sourceEntityId, row]));
    const stale = input.versions
      .filter((row) => {
        const current = byId.get(row.entityId);
        return (
          !current ||
          current.deletedAt !== null ||
          current.sourceRevision !== row.sourceVersion
        );
      })
      .map((row) => row.entityId);
    const gone = await client.query<{ id: string }>(
      `WITH gone AS (
         UPDATE portal.entity e SET "deletedAt"=now(),"observedAt"=$8::timestamptz,"updatedBy"=$2,"updatedAt"=now(),version=e.version+1
         WHERE e."companyId"=$1 AND e."sourceId"=$3 AND e."entityType"=$4 AND e."deletedAt" IS NULL
           AND e."observedAt"<=$8::timestamptz
           AND ($5::text IS NULL OR e."sourceEntityId" COLLATE "C" > $5)
           AND ($6::text IS NULL OR e."sourceEntityId" COLLATE "C" <= $6)
           AND NOT (e."sourceEntityId" = ANY($7::text[]))
         RETURNING e.id,e."entityType",e."sourceEntityId"
       ), queued AS (
         INSERT INTO portal.outbox ("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
         SELECT $1,$2,$3,'entity',gone.id,'sweep:'||$8,'delete',jsonb_build_object('sourceEntityType',gone."entityType",'sourceEntityId',gone."sourceEntityId")
         FROM gone
         ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO NOTHING
         RETURNING "entityId"
       ) SELECT id FROM gone`,
      [
        principal.companyId,
        input.automationUserId,
        input.sourceId,
        input.portalEntityType,
        input.afterId,
        input.lastId,
        ids,
        input.observedAt
      ]
    );
    const advanced = await client.query(
      `UPDATE portal.source SET cursor=COALESCE(cursor,'{}'::jsonb)||jsonb_build_object('carbonSweep',$3::jsonb),"updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND id=$4`,
      [
        principal.companyId,
        input.automationUserId,
        JSON.stringify(input.next),
        input.sourceId
      ]
    );
    if (advanced.rowCount !== 1)
      throw new Error("Carbon sweep cursor could not advance");
    return { stale, tombstoned: gone.rowCount ?? 0 };
  });
}
