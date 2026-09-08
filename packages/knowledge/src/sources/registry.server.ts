import { z } from "zod";
import { createGenericReadAdapter } from "./generic.server";
import {
  createSourceTransport,
  type SourceRequestContext
} from "./http.server";

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
            kind: z.enum(["carbon", "kanban", "engineering", "crm"]),
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
export const itemSchema = z.object({
  id,
  readableId: z.string().max(256),
  name: z.string().max(500),
  revision: z.string().max(256).nullable(),
  mpn: z.string().max(256).nullable(),
  description: z.string().max(16000).nullable().optional()
});
export const ticketSchema = z.object({
  id,
  boardId: id,
  columnId: id,
  title: z.string().max(300),
  description: z.string().max(16000).nullable(),
  dueDate: z.string().max(40).nullable(),
  version: z.number().int().positive(),
  updatedAt: z.string().max(40),
  archivedAt: z.string().max(40).nullable()
});
export const receiptIdentitySchema = z.object({
  id,
  itemId: id,
  revision: z.string().max(256),
  manufacturer: z.string().max(256),
  mpn: z.string().max(256),
  receivedAt: z.string().datetime({ offset: true }),
  quantity: z.string().max(45),
  reversedQuantity: z.string().max(45),
  posted: z.boolean(),
  voided: z.boolean(),
  serial: z.string().max(256).optional(),
  lot: z.string().max(256).optional(),
  variant: z.string().max(256).optional(),
  missingIdentityFields: z
    .array(z.enum(["manufacturer", "mpn", "serial", "lot"]))
    .max(4)
    .optional()
});
export function createSourceRegistry(
  configuration: SourceRegistryConfiguration,
  context: SourceRequestContext
) {
  const config = sourceRegistryConfigurationSchema.parse(configuration);
  return {
    list: () => config.sources.map(({ id, kind }) => ({ id, kind })),
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
          const result = await transport.post(
            "/api/v1/knowledge/resolveItems",
            { search, limit: 40 }
          );
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
              await transport.post("/api/v1/knowledge/getRecentReceiptItems", {
                itemIds,
                limit: 40
              })
            );
        },
        async getItem(itemId: string) {
          return itemSchema.nullable().parse(
            await transport.post("/api/v1/knowledge/getItemIdentity", {
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
              await transport.post("/api/v1/knowledge/getPurchaseStatus", {
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
              await transport.post("/api/knowledge/tickets/search", {
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
                `/api/knowledge/tickets/${encodeURIComponent(ticketId)}`
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
            .parse(await transport.get("/api/knowledge/catalog"));
        }
      };
    }
  };
}
