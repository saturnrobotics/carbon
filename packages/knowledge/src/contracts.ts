import { parseDate } from "@internationalized/date";
import { z } from "zod";

export const KNOWLEDGE_CONTRACT_VERSION = "knowledge.v1" as const;

export const KNOWLEDGE_LIMITS = {
  idCharacters: 256,
  identifierCharacters: 512,
  titleCharacters: 500,
  ticketTitleCharacters: 300,
  queryCharacters: 8_000,
  excerptCharacters: 8_000,
  descriptionCharacters: 16_000,
  uriCharacters: 2_048,
  jsonBytes: 32_768,
  pageItems: 100,
  capabilities: 100,
  sources: 100,
  clarificationChoices: 20,
  unresolvedFields: 100,
  reviewDecisions: 500
} as const;

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(KNOWLEDGE_LIMITS.idCharacters)
  .regex(/^\S+$/, "IDs cannot contain whitespace");
const boundedIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(KNOWLEDGE_LIMITS.identifierCharacters);
const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(KNOWLEDGE_LIMITS.titleCharacters);
export const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const positiveDecimalSchema = z
  .string()
  .max(34)
  .regex(
    /^(?:0|[1-9]\d{0,27})(?:\.\d{1,5})?$/,
    "Expected a positive decimal with at most 5 places"
  )
  .refine(
    (value) => Number.isFinite(Number(value)) && Number(value) > 0,
    "Quantity must be a finite decimal greater than zero"
  );

export const nonNegativeDecimalSchema = z
  .string()
  .max(34)
  .regex(
    /^(?:0|[1-9]\d{0,27})(?:\.\d{1,5})?$/,
    "Expected a non-negative decimal with at most 5 places"
  )
  .refine(
    (value) => Number.isFinite(Number(value)) && Number(value) >= 0,
    "Expected a finite non-negative decimal"
  );

function isCalendarDate(value: string): boolean {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, "Expected a valid ISO calendar date");

export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Expected an IANA business timezone");

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(KNOWLEDGE_LIMITS.descriptionCharacters),
    z.array(jsonValueSchema).max(KNOWLEDGE_LIMITS.pageItems),
    z
      .record(z.string().min(1).max(200), jsonValueSchema)
      .refine(
        (value) => Object.keys(value).length <= KNOWLEDGE_LIMITS.pageItems,
        `JSON objects may contain at most ${KNOWLEDGE_LIMITS.pageItems} keys`
      )
  ])
);

const boundedJsonObjectSchema = z
  .record(z.string().min(1).max(200), jsonValueSchema)
  .refine(
    (value) => Object.keys(value).length <= KNOWLEDGE_LIMITS.pageItems,
    `JSON objects may contain at most ${KNOWLEDGE_LIMITS.pageItems} keys`
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      KNOWLEDGE_LIMITS.jsonBytes,
    `JSON payload exceeds ${KNOWLEDGE_LIMITS.jsonBytes} bytes`
  );

export const sourceCapabilitySchema = z.enum([
  "source.entities.search",
  "source.entity.read",
  "source.facts.query",
  "source.documents.references.read",
  "source.access.check",
  "source.changes.read",
  "source.index.read"
]);

const sourceIdentitySchema = z
  .object({
    issuer: z.string().url().max(KNOWLEDGE_LIMITS.uriCharacters),
    subject: boundedIdentifierSchema
  })
  .strict();

const humanPrincipalSchema = z
  .object({
    kind: z.literal("human"),
    actorId: opaqueIdSchema,
    companyId: opaqueIdSchema,
    callerId: boundedIdentifierSchema,
    sourceIdentity: sourceIdentitySchema,
    policyVersion: boundedIdentifierSchema,
    capabilities: z
      .array(boundedIdentifierSchema)
      .max(KNOWLEDGE_LIMITS.capabilities)
  })
  .strict();

const machinePrincipalSchema = z
  .object({
    kind: z.literal("machine"),
    callerId: boundedIdentifierSchema,
    companyId: opaqueIdSchema,
    sourceIds: z.array(opaqueIdSchema).min(1).max(KNOWLEDGE_LIMITS.sources),
    policyVersion: boundedIdentifierSchema,
    capabilities: z
      .array(z.enum(["source.changes.read", "source.index.read"]))
      .min(1)
      .max(2)
  })
  .strict();

export const principalSchema = z.discriminatedUnion("kind", [
  humanPrincipalSchema,
  machinePrincipalSchema
]);

const queryContextSchema = z
  .object({
    source: opaqueIdSchema.optional(),
    entityId: opaqueIdSchema.optional(),
    conversationId: opaqueIdSchema.optional()
  })
  .strict();

export const queryRequestSchema = z
  .object({
    requestId: opaqueIdSchema,
    text: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.queryCharacters),
    mode: z.enum(["locate", "read", "auto"]),
    context: queryContextSchema.optional(),
    locale: z
      .string()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
  })
  .strict();

export const sourceEntityRequestSchema = z
  .object({
    sourceId: opaqueIdSchema,
    entityId: z
      .string()
      .min(1)
      .max(KNOWLEDGE_LIMITS.idCharacters)
      .regex(/^[A-Za-z0-9_./-]+$/),
    kind: z
      .enum([
        "item",
        "ticket",
        "purchase-order",
        "part",
        "assembly",
        "pcb",
        "machine",
        "customer",
        "contact"
      ])
      .optional()
  })
  .strict();

const sourceEntityFieldValueSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

export const sourceEntitySchema = z
  .object({
    kind: z.enum([
      "item",
      "ticket",
      "purchase-order",
      "part",
      "assembly",
      "pcb",
      "machine",
      "customer",
      "contact"
    ]),
    title: titleSchema,
    description: z
      .string()
      .max(KNOWLEDGE_LIMITS.descriptionCharacters)
      .nullable(),
    fields: z
      .record(z.string().min(1).max(100), sourceEntityFieldValueSchema)
      .refine(
        (fields) => Object.keys(fields).length <= 30,
        "Source entity views may contain at most 30 fields"
      ),
    sourceRevision: boundedIdentifierSchema,
    observedAt: timestampSchema
  })
  .strict();

export type SourceEntityRequest = z.infer<typeof sourceEntityRequestSchema>;
export type SourceEntity = z.infer<typeof sourceEntitySchema>;

export const evidenceSchema = z
  .object({
    id: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    entityId: opaqueIdSchema.optional(),
    documentVersionId: opaqueIdSchema.optional(),
    sourceRevision: boundedIdentifierSchema,
    title: titleSchema,
    excerpt: z.string().max(KNOWLEDGE_LIMITS.excerptCharacters).optional(),
    page: z.number().int().positive().optional(),
    section: z.string().trim().min(1).max(500).optional(),
    sourceUri: z.string().url().max(KNOWLEDGE_LIMITS.uriCharacters),
    observedAt: timestampSchema,
    effectiveAt: timestampSchema.optional(),
    policyVersion: boundedIdentifierSchema,
    freshness: z.enum(["current", "cached", "partial", "unavailable"])
  })
  .strict();

export function createSourcePageSchema<T extends z.ZodType>(itemSchema: T) {
  return z
    .object({
      items: z.array(itemSchema).max(KNOWLEDGE_LIMITS.pageItems),
      nextCursor: boundedIdentifierSchema.optional(),
      observedAt: timestampSchema,
      sourceRevision: boundedIdentifierSchema,
      status: z.enum(["complete", "partial", "unavailable"]),
      incompleteReason: z.string().trim().min(1).max(1_000).optional()
    })
    .strict()
    .superRefine((page, context) => {
      if (page.status !== "complete" && !page.incompleteReason) {
        context.addIssue({
          code: "custom",
          path: ["incompleteReason"],
          message: "Partial and unavailable pages require an incomplete reason"
        });
      }
    });
}

export const sourcePageSchema = createSourcePageSchema(jsonValueSchema);

export const documentVersionSchema = z
  .object({
    id: opaqueIdSchema,
    documentId: opaqueIdSchema,
    sourceRevision: boundedIdentifierSchema,
    contentHash: sha256Schema,
    objectKey: z.string().trim().min(1).max(1_024),
    objectGeneration: boundedIdentifierSchema,
    mimeType: z.string().trim().min(1).max(255),
    byteCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    extractedTextKey: z.string().trim().min(1).max(1_024).optional(),
    observedAt: timestampSchema,
    effectiveAt: timestampSchema.optional(),
    parserVersion: boundedIdentifierSchema,
    extractionStatus: z.enum(["pending", "ready", "failed"])
  })
  .strict();

const fieldProvenanceSchema = z
  .object({
    evidenceIds: z.array(opaqueIdSchema).min(1).max(100),
    confidence: z.number().finite().min(0).max(1).optional()
  })
  .strict();

const unresolvedFieldSchema = z
  .object({
    field: boundedIdentifierSchema,
    reason: z.string().trim().min(1).max(1_000),
    choices: z.array(z.string().min(1).max(500)).max(20).optional()
  })
  .strict();

const reviewDecisionSchema = z
  .object({
    field: boundedIdentifierSchema,
    value: jsonValueSchema,
    decision: z.enum(["accepted", "corrected", "rejected"])
  })
  .strict();

export const intakeProposalSchema = z
  .object({
    id: opaqueIdSchema,
    version: z.number().int().positive(),
    sourceId: opaqueIdSchema,
    document: z
      .object({
        title: titleSchema,
        kind: z.enum([
          "manual",
          "procedure",
          "note",
          "specification",
          "design",
          "other"
        ]),
        classification: boundedIdentifierSchema
      })
      .strict(),
    extracted: boundedJsonObjectSchema,
    provenance: z
      .record(boundedIdentifierSchema, fieldProvenanceSchema)
      .refine(
        (value) => Object.keys(value).length <= KNOWLEDGE_LIMITS.pageItems,
        `Provenance may contain at most ${KNOWLEDGE_LIMITS.pageItems} fields`
      ),
    unresolved: z
      .array(unresolvedFieldSchema)
      .max(KNOWLEDGE_LIMITS.unresolvedFields),
    reviewDecisions: z
      .array(reviewDecisionSchema)
      .max(KNOWLEDGE_LIMITS.reviewDecisions)
  })
  .strict();

const commandTargetSchema = z
  .object({
    sourceId: opaqueIdSchema,
    resourceId: opaqueIdSchema
  })
  .strict();

const clarificationSchema = z
  .object({
    field: boundedIdentifierSchema,
    choices: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(KNOWLEDGE_LIMITS.clarificationChoices)
  })
  .strict();

const commandEnvelopeShape = {
  id: opaqueIdSchema,
  version: z.number().int().positive(),
  target: commandTargetSchema,
  payloadHash: sha256Schema,
  idempotencyKey: boundedIdentifierSchema,
  executeAt: timestampSchema.optional(),
  clarification: clarificationSchema.optional()
} as const;

export const ticketCommandPayloadSchema = z
  .object({
    boardId: opaqueIdSchema,
    initialColumnId: opaqueIdSchema,
    title: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.ticketTitleCharacters),
    description: z.string().max(KNOWLEDGE_LIMITS.descriptionCharacters),
    dueDate: calendarDateSchema,
    businessTimezone: timezoneSchema,
    assigneeId: opaqueIdSchema.optional()
  })
  .strict();

export const procurementCommandPayloadSchema = z
  .object({
    itemId: opaqueIdSchema,
    itemRevision: boundedIdentifierSchema,
    quantity: positiveDecimalSchema.optional(),
    purchaseUnitOfMeasureCode: boundedIdentifierSchema,
    supplierId: opaqueIdSchema.optional(),
    locationId: opaqueIdSchema.optional(),
    requestedArrivalDate: calendarDateSchema,
    proposedOrderByDate: calendarDateSchema.optional(),
    executeAt: timestampSchema.optional()
  })
  .strict();

const ticketCommandProposalSchema = z
  .object({
    ...commandEnvelopeShape,
    action: z.literal("kanban.ticket.create"),
    payload: ticketCommandPayloadSchema
  })
  .strict();

const procurementCommandProposalSchema = z
  .object({
    ...commandEnvelopeShape,
    action: z.literal("carbon.procurement.draft"),
    payload: procurementCommandPayloadSchema
  })
  .strict()
  .superRefine((proposal, context) => {
    const missing = (["quantity", "supplierId", "locationId"] as const).filter(
      (field) => proposal.payload[field] === undefined
    );
    if (
      missing.length > 0 &&
      (!proposal.clarification ||
        !missing.some((field) => field === proposal.clarification?.field))
    ) {
      context.addIssue({
        code: "custom",
        path: ["clarification"],
        message: `Missing ${missing.join(", ")} requires clarification`
      });
    }
  });

export const commandProposalSchema = z.union([
  ticketCommandProposalSchema,
  procurementCommandProposalSchema
]);

export type SourceCapability = z.infer<typeof sourceCapabilitySchema>;
export type Principal = z.infer<typeof principalSchema>;
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type SourcePage = z.infer<typeof sourcePageSchema>;
export type DocumentVersion = z.infer<typeof documentVersionSchema>;
export type IntakeProposal = z.infer<typeof intakeProposalSchema>;
export type CommandProposal = z.infer<typeof commandProposalSchema>;

export const knowledgeJsonSchemas = {
  Principal: z.toJSONSchema(principalSchema),
  SourceCapability: z.toJSONSchema(sourceCapabilitySchema),
  QueryRequest: z.toJSONSchema(queryRequestSchema),
  SourceEntityRequest: z.toJSONSchema(sourceEntityRequestSchema),
  SourceEntity: z.toJSONSchema(sourceEntitySchema),
  Evidence: z.toJSONSchema(evidenceSchema),
  SourcePage: z.toJSONSchema(sourcePageSchema),
  DocumentVersion: z.toJSONSchema(documentVersionSchema),
  IntakeProposal: z.toJSONSchema(intakeProposalSchema),
  CommandProposal: z.toJSONSchema(commandProposalSchema)
} as const;

export const knowledgeOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Carbon Knowledge Contracts",
    version: KNOWLEDGE_CONTRACT_VERSION
  },
  paths: {},
  components: { schemas: knowledgeJsonSchemas }
} as const;
