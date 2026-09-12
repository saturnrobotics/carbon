import { z } from "zod";
import { createSourcePageSchema } from "../contracts";

const id = z.string().min(1).max(256);
/** Raw Carbon and Kanban projections as the source APIs return them. */
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
export const sourceEntitySchema = z
  .object({
    id,
    type: z.enum([
      "part",
      "assembly",
      "pcb",
      "machine",
      "customer",
      "contact",
      "ticket",
      "purchase-order",
      "receipt"
    ]),
    title: z.string().min(1).max(500),
    description: z.string().max(8000).optional(),
    revision: z.string().min(1).max(512),
    fields: z
      .record(
        z.string().min(1).max(100),
        z.union([
          z.string().max(1000),
          z.number().finite(),
          z.boolean(),
          z.null()
        ])
      )
      .refine((fields) => Object.keys(fields).length <= 30)
  })
  .strict();
export const entityPageSchema = createSourcePageSchema(sourceEntitySchema);
export const documentReferenceSchema = z
  .object({
    id,
    entityId: id,
    documentVersionId: id,
    title: z.string().max(500),
    relation: z.enum([
      "manual-for",
      "specification-for",
      "derived-from",
      "related"
    ]),
    sourceRevision: z.string().min(1).max(512)
  })
  .strict();
export const documentReferencePageSchema = createSourcePageSchema(
  documentReferenceSchema
);
export const sourceSearchSchema = z
  .object({
    query: z.string().min(1).max(8000),
    limit: z.number().int().min(1).max(40),
    cursor: z.string().max(512).optional()
  })
  .strict();
export const factQuerySchema = z
  .object({
    entityId: id,
    fact: z.enum(["status", "revision", "availability", "contact-summary"])
  })
  .strict();
export const factsSchema = z
  .object({
    entityId: id,
    sourceRevision: z.string().min(1).max(512),
    observedAt: z.string().datetime({ offset: true }),
    facts: z
      .array(
        z
          .object({
            label: z.string().min(1).max(100),
            value: z.string().max(1000)
          })
          .strict()
      )
      .max(30)
  })
  .strict();
export const accessResultSchema = z
  .object({
    allowedIds: z.array(id).max(40),
    policyVersion: z.string().min(1).max(512),
    validUntil: z.string().datetime({ offset: true })
  })
  .strict();

/**
 * A structured read outcome. Every branch is safe to show a reader: the
 * `ambiguous` choices are rows the caller already received through the
 * source's own authorization, `moreHidden` says only THAT more candidates
 * exist behind the limit or the caller's permission — never how many, never
 * their names — and `unavailable` is distinct from an empty result so a source
 * outage can never be rendered as an authoritative "nothing found".
 */
export const sourceOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok") }).strict(),
  z
    .object({
      kind: z.literal("ambiguous"),
      choices: z
        .array(z.object({ id, label: z.string().min(1).max(500) }).strict())
        .max(20),
      moreHidden: z.boolean()
    })
    .strict(),
  z.object({ kind: z.literal("not-found") }).strict(),
  z.object({ kind: z.literal("insufficient-permission") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum([
        "deadline",
        "transport",
        "source-error",
        "unregistered",
        "unsupported"
      ])
    })
    .strict()
]);
export type SourceOutcome = z.infer<typeof sourceOutcomeSchema>;

/** One source-owned change. `entity` is the projection observed at claim time. */
export const sourceChangeSchema = z
  .object({
    id,
    entityType: z.string().min(1).max(100),
    entityId: id,
    sourceVersion: z.string().min(1).max(512),
    eventType: z.enum(["upsert", "delete", "acl-change"]),
    observedAt: z.string().datetime({ offset: true }),
    /**
     * The indexed entity this change lands on when it differs from the source
     * row (a receipt line announces its receipt). Defaults to the row itself.
     */
    target: z
      .object({ entityType: z.string().min(1).max(100), entityId: id })
      .strict()
      .optional(),
    /** The projection observed at claim time; absent means "no longer visible". */
    entity: sourceEntitySchema.nullable().optional()
  })
  .strict();
export const changePageSchema = createSourcePageSchema(sourceChangeSchema).and(
  z.object({
    /** Present on lease-style feeds: the worker must acknowledge before it. */
    leaseExpiresAt: z.string().datetime({ offset: true }).optional()
  })
);
export type SourceChange = z.infer<typeof sourceChangeSchema>;
export type ChangePage = z.infer<typeof changePageSchema>;

/** A source's current version of one entity, for reconciliation sweeps. */
export const entityVersionSchema = z
  .object({ entityId: id, sourceVersion: z.string().min(1).max(512) })
  .strict();
export const entityVersionPageSchema =
  createSourcePageSchema(entityVersionSchema);
export type EntityVersionPage = z.infer<typeof entityVersionPageSchema>;
