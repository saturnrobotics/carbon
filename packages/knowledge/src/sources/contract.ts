import { z } from "zod";
import { createSourcePageSchema } from "../contracts";

const id = z.string().min(1).max(256);
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
      "ticket"
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
