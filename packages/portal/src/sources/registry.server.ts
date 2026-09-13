import { z } from "zod";
import { createCarbonSourceAdapter } from "./carbon.server";
import {
  itemSchema,
  receiptIdentitySchema,
  SOURCE_CONTRACT_SCHEMA_VERSION,
  type SourceAdapterDescriptor,
  type SourceKind,
  sourceAdapterDescriptorSchema,
  sourceKindSchema,
  ticketSchema
} from "./contract";
import {
  createGenericReadAdapter,
  genericSourceDescriptor
} from "./generic.server";
import {
  createSourceTransport,
  type SourceRequestContext
} from "./http.server";
import { createKanbanSourceAdapter } from "./kanban.server";
import { SOURCE_FACT_VALIDITY_SECONDS } from "./outcome";

export { itemSchema, receiptIdentitySchema, ticketSchema } from "./contract";

/**
 * The declarative registration table: one row per adapter kind, each naming
 * its descriptor and its factory. The registry, the query service and the
 * conformance suite read this table; none of them branches on a kind that is
 * not in it. Adding a producer kind is adding a row here, not a router edit.
 */
export const SOURCE_ADAPTERS: Readonly<
  Record<SourceKind, Readonly<{ descriptor: SourceAdapterDescriptor }>>
> = Object.freeze({
  carbon: Object.freeze({
    descriptor: sourceAdapterDescriptorSchema.parse({
      kind: "carbon",
      schemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
      capabilities: [
        "entities.search",
        "entities.get",
        "facts.query",
        "documents.references",
        "access.check",
        "changes.feed"
      ],
      entityTypes: ["part", "purchase-order", "receipt"],
      auth: {
        human: "workforce-forwarding",
        machine: "service-token",
        requiredCapability: "portal.read"
      },
      filters: ["query", "entityId", "limit"],
      projections: {
        fields: [
          "readableId",
          "readableIdWithRevision",
          "revision",
          "revisionStatus",
          "mpn",
          "itemType",
          "unitOfMeasureCode",
          "active",
          "updatedAt",
          "purchaseOrderId",
          "status",
          "orderDate",
          "revisionId",
          "supplierId",
          "supplierReference",
          "closedAt",
          "receiptId",
          "postingDate",
          "sourceDocument",
          "sourceDocumentId",
          "sourceDocumentReadableId",
          "locationId",
          "link"
        ],
        facts: ["status", "revision", "availability"]
      },
      freshness: {
        factValiditySeconds: SOURCE_FACT_VALIDITY_SECONDS,
        revisions: "mutable"
      },
      // Carbon's resolver has no cursor: a full page means "narrow the search".
      pagination: { style: "bounded", maxLimit: 40 },
      rateLimit: { requestsPerMinute: 600, concurrent: 8 },
      events: {
        feed: "lease",
        eventTypes: ["upsert", "delete", "acl-change"],
        deletion: "tombstone-event"
      },
      deepLinks: { field: "link", authorizedOnOpen: true }
    })
  }),
  kanban: Object.freeze({
    descriptor: sourceAdapterDescriptorSchema.parse({
      kind: "kanban",
      schemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
      capabilities: [
        "entities.search",
        "entities.get",
        "facts.query",
        "documents.references",
        "access.check",
        "changes.feed"
      ],
      entityTypes: ["ticket"],
      auth: {
        human: "workforce-forwarding",
        machine: "service-token",
        requiredCapability: "portal.read"
      },
      filters: ["query", "entityId", "cursor", "limit"],
      projections: {
        fields: [
          "boardId",
          "columnId",
          "dueDate",
          "version",
          "updatedAt",
          "archivedAt",
          "link"
        ],
        facts: ["status", "revision"]
      },
      freshness: {
        factValiditySeconds: SOURCE_FACT_VALIDITY_SECONDS,
        revisions: "mutable"
      },
      pagination: { style: "cursor", maxLimit: 40 },
      rateLimit: { requestsPerMinute: 600, concurrent: 8 },
      events: {
        feed: "cursor",
        eventTypes: ["upsert", "delete", "acl-change"],
        deletion: "tombstone-event"
      },
      deepLinks: { field: "link", authorizedOnOpen: true }
    })
  }),
  engineering: Object.freeze({
    descriptor: genericSourceDescriptor("engineering")
  }),
  crm: Object.freeze({ descriptor: genericSourceDescriptor("crm") })
});

const id = z.string().min(1).max(256);
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  });
export const sourceRegistryConfigurationSchema = z
  .object({
    version: z.literal(1),
    sources: z
      .array(
        z
          .object({
            id,
            kind: sourceKindSchema,
            origin,
            audience: z.string().min(1).max(2048)
          })
          .strict()
      )
      .max(100)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.sources.map((source) => source.id)).size !==
      value.sources.length
    )
      context.addIssue({ code: "custom", message: "Duplicate source ID" });
  });
export type SourceRegistryConfiguration = z.infer<
  typeof sourceRegistryConfigurationSchema
>;
export function createSourceRegistry(
  configuration: SourceRegistryConfiguration,
  context: SourceRequestContext
) {
  const config = sourceRegistryConfigurationSchema.parse(configuration);
  return {
    list: () => config.sources.map(({ id, kind }) => ({ id, kind })),
    /** The declared contract of a registered source; what every consumer may assume. */
    describe(sourceId: string): SourceAdapterDescriptor {
      const connection = config.sources.find(
        (source) => source.id === sourceId
      );
      if (!connection) throw Error("Source unavailable");
      return SOURCE_ADAPTERS[connection.kind].descriptor;
    },
    /** The uniform finite-contract adapter for a registered Carbon or Kanban source. */
    adapter(sourceId: string) {
      const connection = config.sources.find(
        (source) =>
          source.id === sourceId &&
          (source.kind === "carbon" || source.kind === "kanban")
      );
      if (!connection) throw Error("Source unavailable");
      return connection.kind === "carbon"
        ? createCarbonSourceAdapter(connection, context)
        : createKanbanSourceAdapter(connection, context);
    },
    generic(sourceId: string) {
      const connection = config.sources.find(
        (source) =>
          source.id === sourceId &&
          (source.kind === "engineering" || source.kind === "crm")
      );
      if (!connection) throw Error("Source unavailable");
      return createGenericReadAdapter(connection, context);
    },
    carbon(sourceId: string) {
      const connection = config.sources.find(
        (source) => source.id === sourceId && source.kind === "carbon"
      );
      if (!connection) throw Error("Source unavailable");
      const transport = createSourceTransport(connection, context);
      return {
        async searchItems(search: string) {
          const result = await transport.post("/api/v1/portal/resolveItems", {
            search,
            limit: 40
          });
          return z
            .array(itemSchema)
            .max(50)
            .parse(
              typeof result === "object" &&
                result !== null &&
                "results" in result
                ? result.results
                : result
            );
        },
        async recentReceiptItems(itemIds: string[]) {
          return z
            .object({
              items: z.array(receiptIdentitySchema).max(100),
              status: z.enum(["complete", "partial"]),
              incompleteReason: z.string().max(1000).optional()
            })
            .parse(
              await transport.post("/api/v1/portal/getRecentReceiptItems", {
                itemIds,
                limit: 40
              })
            );
        },
        async getItem(itemId: string) {
          return itemSchema.nullable().parse(
            await transport.post("/api/v1/portal/getItemIdentity", {
              itemId
            })
          );
        },
        async purchaseStatus(purchaseOrderId: string) {
          return z
            .object({
              id,
              purchaseOrderId: z.string().max(256),
              status: z.string().max(100),
              orderDate: z.string().max(40).nullable(),
              updatedAt: z.string().max(40).nullable()
            })
            .nullable()
            .parse(
              await transport.post("/api/v1/portal/getPurchaseStatus", {
                purchaseOrderId
              })
            );
        }
      };
    },
    kanban(sourceId: string) {
      const connection = config.sources.find(
        (source) => source.id === sourceId && source.kind === "kanban"
      );
      if (!connection) throw Error("Source unavailable");
      const transport = createSourceTransport(connection, context);
      return {
        async searchTickets(query: string) {
          return z
            .object({
              sourceRevision: z.string().max(512),
              items: z.array(ticketSchema).max(40),
              nextCursor: id.nullable(),
              observedAt: z.string().max(40)
            })
            .strict()
            .parse(
              await transport.post("/api/portal/tickets/search", {
                query,
                limit: 40
              })
            );
        },
        async getTicket(ticketId: string) {
          return z
            .object({
              sourceRevision: z.string().max(512),
              observedAt: z.string().max(40),
              ticket: ticketSchema
            })
            .strict()
            .parse(
              await transport.get(
                `/api/portal/tickets/${encodeURIComponent(ticketId)}`
              )
            );
        },
        async catalog() {
          return z
            .object({
              sourceRevision: z.string().max(512),
              observedAt: z.string().max(40),
              partial: z.boolean(),
              boards: z
                .array(
                  z.object({
                    id,
                    name: z.string().max(500),
                    archivedAt: z.string().max(40).nullable()
                  })
                )
                .max(100),
              columns: z
                .array(
                  z.object({
                    id,
                    boardId: id,
                    name: z.string().max(500),
                    isInitial: z.boolean(),
                    completionStatus: z.string().max(100)
                  })
                )
                .max(500)
            })
            .strict()
            .parse(await transport.get("/api/portal/catalog"));
        }
      };
    }
  };
}
