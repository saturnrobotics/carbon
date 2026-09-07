import { z } from "zod";

export const INVOICE_SCHEMA_VERSION = "invoice-intake.v1" as const;
export const INVOICE_PROMPT_VERSION = "invoice-intake.2026-09-06.1" as const;
export const INVOICE_LIMITS = {
  pdfBytes: 10 * 1024 * 1024,
  imageBytes: 7_000_000,
  pages: 20,
  lines: 500,
  attempts: 3,
  concurrency: 2,
  requestTimeoutMs: 120_000,
  leaseSeconds: 300
} as const;

export const invoiceItemTypes = [
  "Part",
  "Material",
  "Consumable",
  "Tool",
  "Service"
] as const;
export const invoiceLineTypes = [
  ...invoiceItemTypes,
  "G/L Account",
  "Fixed Asset",
  "Comment"
] as const;
export const invoiceIntakeStatuses = [
  "NeedsDocument",
  "Queued",
  "Processing",
  "NeedsReview",
  "Ready",
  "Approved",
  "Linked",
  "Ignored",
  "Failed"
] as const;
export const invoiceDocumentKinds = [
  "invoice",
  "receipt",
  "credit",
  "statement",
  "paymentConfirmation",
  "multiple",
  "unknown"
] as const;

/** Gmail matching is deferred; payment placeholders are context, not documents. */
export function getInvoiceDocumentSources<
  T extends {
    kind: string;
    storagePath: string | null;
    sha256: string | null;
    provenance?: unknown;
  }
>(sources: readonly T[]): T[] {
  return sources.filter(
    (source) =>
      (source.kind === "mercury" || source.kind === "upload") &&
      !!source.storagePath &&
      !!source.sha256 &&
      !(
        source.kind === "mercury" &&
        source.provenance &&
        typeof source.provenance === "object" &&
        "current" in source.provenance &&
        source.provenance.current === false
      )
  );
}

/** These persisted business facts must never be replaced by background extraction. */
export function hasInvoiceReviewFacts(header: unknown): boolean {
  if (!header || typeof header !== "object" || Array.isArray(header))
    return false;
  const values = header as Record<string, unknown>;
  if (values.chargesConfirmed === true || values.resolvedSourceIssues === true)
    return true;
  return [
    "sourceSupplierName",
    "invoiceNumber",
    "issueDate",
    "dueDate",
    "currencyCode",
    "subtotal",
    "tax",
    "shipping",
    "discount",
    "total",
    "paymentReviewReason"
  ].some(
    (key) =>
      values[key] !== null && values[key] !== undefined && values[key] !== ""
  );
}

/** Content identities remain stable when source IDs/paths are remapped on restore. */
const sourceHash = z.string().regex(/^[0-9a-f]{64}$/);
/** Exact approval identity wins over later provider attachment membership. Null is legacy unknown. */
export function getInvoiceApprovedSourceHashes(
  snapshot: unknown
): string[] | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return null;
  const record = snapshot as Record<string, unknown>;
  if (Object.hasOwn(record, "sourceSha256s")) {
    const parsed = z.array(sourceHash).max(100).safeParse(record.sourceSha256s);
    return parsed.success ? [...new Set(parsed.data)].sort() : [];
  }
  const review = record.resolved ?? record.review;
  if (
    !review ||
    typeof review !== "object" ||
    !("header" in review) ||
    !review.header ||
    typeof review.header !== "object"
  )
    return null;
  const header = review.header as Record<string, unknown>;
  const hashes = [
    header.primarySourceSha256,
    ...(Array.isArray(header.sourceAcknowledgements)
      ? header.sourceAcknowledgements.map((entry) =>
          entry && typeof entry === "object" ? entry.sha256 : null
        )
      : [])
  ].filter((value) => value !== null && value !== undefined);
  if (!hashes.length) return null;
  const parsed = z.array(sourceHash).max(100).safeParse(hashes);
  return parsed.success ? [...new Set(parsed.data)].sort() : [];
}

export const invoiceSourceReviewSchema = z.object({
  primarySourceSha256: sourceHash.nullable().default(null),
  sourceAcknowledgements: z
    .array(
      z.object({
        sha256: sourceHash,
        reason: z.string().trim().min(1).max(1000)
      })
    )
    .max(100)
    .default([])
});

/** Keep decimal evidence lossless until Carbon's numeric persistence boundary. */
export const invoiceDecimalSchema = z
  .string()
  .max(40)
  .regex(/^-?\d+(?:\.\d+)?$/)
  .refine(
    (value) =>
      Number.isFinite(Number(value)) &&
      Math.abs(Number(value)) <= Number.MAX_SAFE_INTEGER,
    "Enter a finite decimal within the supported range"
  );
const text = z.string().max(4000);
export const invoiceEvidenceSchema = <T extends z.ZodType>(value: T) =>
  z
    .object({
      value: value.nullable(),
      confidence: z.number().finite().min(0).max(1).nullable(),
      sourceText: text.nullable(),
      page: z.number().int().min(1).max(INVOICE_LIMITS.pages).nullable()
    })
    .strict();
const textEvidence = invoiceEvidenceSchema(text);
const decimalEvidence = invoiceEvidenceSchema(invoiceDecimalSchema);

export const invoiceExtractionEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(INVOICE_SCHEMA_VERSION),
    documentKind: z.enum(invoiceDocumentKinds),
    supplier: z
      .object({
        name: textEvidence,
        email: textEvidence,
        phone: textEvidence,
        taxId: textEvidence,
        addressLine1: textEvidence,
        addressLine2: textEvidence,
        city: textEvidence,
        state: textEvidence,
        postalCode: textEvidence,
        countryCode: textEvidence
      })
      .strict(),
    header: z
      .object({
        invoiceNumber: textEvidence,
        issueDate: textEvidence,
        dueDate: textEvidence,
        currencyCode: textEvidence,
        subtotal: decimalEvidence,
        discount: decimalEvidence,
        shipping: decimalEvidence,
        tax: decimalEvidence,
        total: decimalEvidence
      })
      .strict(),
    lines: z
      .array(
        z
          .object({
            lineKey: z.string().min(1).max(100),
            page: z.number().int().min(1).max(INVOICE_LIMITS.pages).nullable(),
            sourceText: text.nullable(),
            description: textEvidence,
            supplierSku: textEvidence,
            manufacturerPartNumber: textEvidence,
            quantity: decimalEvidence,
            purchaseUnit: textEvidence,
            packText: textEvidence,
            unitPrice: decimalEvidence,
            discount: decimalEvidence,
            tax: decimalEvidence,
            taxPercent: decimalEvidence,
            shipping: decimalEvidence,
            lineTotal: decimalEvidence,
            suggestedType: invoiceEvidenceSchema(z.enum(invoiceItemTypes))
          })
          .strict()
      )
      .max(INVOICE_LIMITS.lines),
    issues: z.array(text).max(100)
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    value.lines.forEach((line, index) => {
      if (keys.has(line.lineKey))
        context.addIssue({
          code: "custom",
          path: ["lines", index, "lineKey"],
          message: "Duplicate source line identity"
        });
      keys.add(line.lineKey);
    });
  });

export type InvoiceExtractionEnvelope = z.infer<
  typeof invoiceExtractionEnvelopeSchema
>;
export type InvoiceExtractedLine = InvoiceExtractionEnvelope["lines"][number];
export type InvoiceItemType = (typeof invoiceItemTypes)[number];
export type InvoiceLineType = (typeof invoiceLineTypes)[number];
export type InvoiceIntakeStatus = (typeof invoiceIntakeStatuses)[number];
export type InvoiceDocumentKind = (typeof invoiceDocumentKinds)[number];
export type InvoiceActor = { companyId: string; userId: string };

export const invoiceMatchSuggestionsSchema = z
  .object({
    supplierId: z.string().nullable(),
    lines: z
      .array(
        z
          .object({
            lineKey: z.string(),
            itemId: z.string().nullable(),
            suggestedType: z.enum(invoiceItemTypes).nullable(),
            confidence: z.number().finite().min(0).max(1),
            reason: z.string().max(500)
          })
          .strict()
      )
      .max(INVOICE_LIMITS.lines)
  })
  .strict();
export type InvoiceMatchSuggestions = z.infer<
  typeof invoiceMatchSuggestionsSchema
>;

export function emptyInvoiceEvidence<T>(value: T | null = null) {
  return { value, confidence: null, sourceText: null, page: null };
}

/** Useful for manual review and synthetic fixtures. Missing evidence stays null. */
export function emptyInvoiceExtraction(): InvoiceExtractionEnvelope {
  const field = () => emptyInvoiceEvidence<string>();
  return {
    schemaVersion: INVOICE_SCHEMA_VERSION,
    documentKind: "unknown",
    supplier: {
      name: field(),
      email: field(),
      phone: field(),
      taxId: field(),
      addressLine1: field(),
      addressLine2: field(),
      city: field(),
      state: field(),
      postalCode: field(),
      countryCode: field()
    },
    header: {
      invoiceNumber: field(),
      issueDate: field(),
      dueDate: field(),
      currencyCode: field(),
      subtotal: field(),
      discount: field(),
      shipping: field(),
      tax: field(),
      total: field()
    },
    lines: [],
    issues: []
  };
}
