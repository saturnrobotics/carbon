import { z } from "zod";

export const intakeInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("object"),
      objectKey: z.string().min(1).max(1024),
      generation: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mimeType: z.string().min(1),
      bytes: z.number().int().positive().max(50_000_000)
    })
    .strict(),
  z
    .object({ kind: z.literal("url"), url: z.string().url().max(2048) })
    .strict(),
  z
    .object({
      kind: z.literal("source"),
      sourceVersion: z.string().min(1).max(256),
      sourceItemId: z.string().min(1).max(256)
    })
    .strict()
]);

export type IntakeInput = z.infer<typeof intakeInputSchema>;
export const reviewedManualMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    manufacturer: z.string().trim().max(256),
    partNumber: z.string().trim().max(256),
    revision: z.string().trim().max(256),
    machine: z.string().trim().max(256)
  })
  .strict();
export type ReviewedManualMetadata = z.infer<
  typeof reviewedManualMetadataSchema
>;
/** One reviewer-chosen existing item, or none. The candidate list is read from
 * the Carbon canonical source at review time; only the bounded identity that a
 * later linking layer needs is retained with the review. */
export const itemAssociationSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    readableId: z.string().trim().max(256),
    name: z.string().trim().max(500),
    revision: z.string().max(256).nullable(),
    mpn: z.string().max(256).nullable()
  })
  .strict();
export type ItemAssociation = z.infer<typeof itemAssociationSchema>;
export type Evidence = { page: number; region?: string; text: string };
export type Extraction = {
  fields: Record<string, unknown>;
  evidence: Record<string, Evidence[]>;
  unresolved: string[];
  warnings: string[];
};
