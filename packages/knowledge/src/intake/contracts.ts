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
export type Evidence = { page: number; region?: string; text: string };

/**
 * Extraction contract versions.
 *
 * - 1: untyped `fields` plus per-field page evidence.
 * - 2: adds typed `proposed` fields with calibrated confidence and units.
 *
 * Stored version-1 generations are immutable and still parse: `extractionSchema`
 * defaults the keys version 2 introduced, so a reader never has to branch.
 */
export const EXTRACTION_CONTRACT_VERSION = 2;
export const extractionContractVersionSchema = z.union([
  z.literal(1),
  z.literal(2)
]);
export type ExtractionContractVersion = z.infer<
  typeof extractionContractVersionSchema
>;

/** Units a dimensional proposal may carry. Text proposals never carry one. */
export const dimensionalUnitSchema = z.enum([
  "mm",
  "cm",
  "m",
  "in",
  "ft",
  "g",
  "kg",
  "lb",
  "N",
  "Nm",
  "V",
  "A",
  "W",
  "Hz",
  "rpm",
  "degC",
  "degF",
  "psi",
  "bar"
]);
export type DimensionalUnit = z.infer<typeof dimensionalUnitSchema>;

export const documentTypeSchema = z.enum([
  "manual",
  "datasheet",
  "drawing",
  "procedure",
  "specification",
  "certificate",
  "other"
]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/** Where on the page a proposal was read from; the text itself lives in `evidence`. */
export const fieldEvidenceReferenceSchema = z
  .object({
    page: z.number().int().min(1).max(2_000),
    region: z.string().trim().min(1).max(256).optional()
  })
  .strict();
export type FieldEvidenceReference = z.infer<
  typeof fieldEvidenceReferenceSchema
>;

const proposalShape = {
  confidence: z.number().min(0).max(1),
  evidence: z.array(fieldEvidenceReferenceSchema).max(100)
};

function proposedTextFieldSchema(maxLength: number) {
  return z
    .object({
      value: z.string().trim().min(1).max(maxLength),
      ...proposalShape
    })
    .strict();
}
export const proposedDocumentTypeFieldSchema = z
  .object({ value: documentTypeSchema, ...proposalShape })
  .strict();
export const proposedMeasurementFieldSchema = z
  .object({ value: z.number(), unit: dimensionalUnitSchema, ...proposalShape })
  .strict();

export const MEASUREMENT_LIMIT = 50;
export const measurementNamePattern = /^[a-z][a-zA-Z0-9]{0,63}$/;

/**
 * Typed proposals a parser may make about a document's identity. Each carries
 * the calibrated confidence and the page/region references that back it. Only
 * `measurements` carry a unit; the identity fields are text and reject one.
 */
export const proposedFieldsSchema = z
  .object({
    title: proposedTextFieldSchema(500).optional(),
    manufacturer: proposedTextFieldSchema(256).optional(),
    mpn: proposedTextFieldSchema(256).optional(),
    revision: proposedTextFieldSchema(256).optional(),
    documentType: proposedDocumentTypeFieldSchema.optional(),
    measurements: z
      .record(
        z.string().regex(measurementNamePattern),
        proposedMeasurementFieldSchema
      )
      .refine((value) => Object.keys(value).length <= MEASUREMENT_LIMIT, {
        message: `at most ${MEASUREMENT_LIMIT} measurements`
      })
      .optional()
  })
  .strict();
export type ProposedFields = z.infer<typeof proposedFieldsSchema>;
export type ProposedTextField = NonNullable<ProposedFields["mpn"]>;
export type ProposedDocumentTypeField = z.infer<
  typeof proposedDocumentTypeFieldSchema
>;
export type ProposedMeasurementField = z.infer<
  typeof proposedMeasurementFieldSchema
>;
export type ProposedField =
  | ProposedTextField
  | ProposedDocumentTypeField
  | ProposedMeasurementField;

export const PROPOSED_FIELD_NAMES = [
  "title",
  "manufacturer",
  "mpn",
  "revision",
  "documentType"
] as const;
export type ProposedFieldName = (typeof PROPOSED_FIELD_NAMES)[number];

/** Unresolved entry for a measurement proposal, e.g. `measurements.ratedVoltage`. */
export function measurementUnresolvedName(name: string): string {
  return `measurements.${name}`;
}

export type Extraction = {
  contractVersion: ExtractionContractVersion;
  fields: Record<string, unknown>;
  proposed: ProposedFields;
  evidence: Record<string, Evidence[]>;
  unresolved: string[];
  warnings: string[];
};

const evidenceSchema = z.object({
  page: z.number().int(),
  region: z.string().optional(),
  text: z.string()
});

/** Reads any stored generation; version-1 rows gain empty typed proposals. */
export const extractionSchema = z.object({
  contractVersion: extractionContractVersionSchema.default(1),
  fields: z.record(z.string(), z.unknown()),
  proposed: proposedFieldsSchema.default({}),
  evidence: z.record(z.string(), z.array(evidenceSchema)),
  unresolved: z.array(z.string()),
  warnings: z.array(z.string())
});

export function parseStoredExtraction(value: unknown): Extraction {
  return extractionSchema.parse(value);
}
