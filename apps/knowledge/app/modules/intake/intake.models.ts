import type { ItemCandidate } from "@carbon/knowledge";
import {
  measurementUnresolvedName,
  type ProposedField,
  type ProposedFields,
  proposedFieldsSchema
} from "@carbon/knowledge/intake/contracts";
import { z } from "zod";

export type IntakeState =
  | "captured"
  | "extracting"
  | "needs-review"
  | "ready"
  | "failed";

export type IntakeEvidence = {
  /** Parser field the excerpt supports (`title`, `manual`, ...). */
  field: string;
  page: number;
  region?: string;
  text: string;
};

export const manualMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    manufacturer: z.string().trim().max(256),
    partNumber: z.string().trim().max(256),
    revision: z.string().trim().max(256),
    machine: z.string().trim().max(256)
  })
  .strict();
export type ManualMetadata = z.infer<typeof manualMetadataSchema>;
export const manualMetadataFields = Object.keys(
  manualMetadataSchema.shape
) as (keyof ManualMetadata)[];

/** The item a reviewer associated, as kept with the review. `sourceId` is
 * browser-side context only and is not part of the stored association. */
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

export function toItemAssociation(candidate: ItemCandidate): ItemAssociation {
  return {
    id: candidate.id,
    readableId: candidate.readableId,
    name: candidate.name,
    revision: candidate.revision,
    mpn: candidate.mpn
  };
}

export type IntakeReviewModel = {
  id: string;
  version?: string;
  generation?: string;
  state: IntakeState;
  /** Set once the review was published; the intake is then read-only. */
  published: boolean;
  title: string;
  proposed: Record<string, string>;
  corrected: Record<string, string>;
  /** Typed proposals from the current extraction generation, when it has any. */
  proposedFields?: ProposedFields;
  unresolved: string[];
  evidence: IntakeEvidence[];
  item: ItemAssociation | null;
  /** Whether a reviewer already answered the item question (even with "none"). */
  itemDecided: boolean;
  acquiredFrom?: string;
};

export const reviewFields = [
  ["title", "Title"],
  ["manufacturer", "Manufacturer"],
  ["partNumber", "Part number"],
  ["revision", "Revision"],
  ["machine", "Machine"]
] as const;
export type ReviewField = (typeof reviewFields)[number][0];

/** Review inputs use the reviewed metadata names; typed proposals use the parser's. */
const proposedFieldForInput: Readonly<
  Record<ReviewField, "title" | "manufacturer" | "mpn" | "revision" | null>
> = {
  title: "title",
  manufacturer: "manufacturer",
  partNumber: "mpn",
  revision: "revision",
  machine: null
};

function isReviewField(field: string): field is ReviewField {
  return reviewFields.some(([name]) => name === field);
}

export function proposalFor(
  model: IntakeReviewModel,
  field: ReviewField
): ProposedField | undefined {
  const name = proposedFieldForInput[field];
  return name ? model.proposedFields?.[name] : undefined;
}

/** Every name under which an input may appear in `unresolved`: its own and its proposal's. */
export function unresolvedNamesFor(field: ReviewField): string[] {
  const name = proposedFieldForInput[field];
  return name && name !== field ? [field, name] : [field];
}

export function displayField(model: IntakeReviewModel, field: string) {
  const proposal = isReviewField(field) ? proposalFor(model, field) : undefined;
  const proposedValue =
    proposal && typeof proposal.value === "string" ? proposal.value : undefined;
  return model.corrected[field] ?? model.proposed[field] ?? proposedValue ?? "";
}

export type ProposalRow = {
  name: string;
  label: string;
  proposal: ProposedField;
};

/** Typed proposals with no review input of their own: document type and measurements. */
export function additionalProposals(model: IntakeReviewModel): ProposalRow[] {
  const rows: ProposalRow[] = [];
  const documentType = model.proposedFields?.documentType;
  if (documentType)
    rows.push({
      name: "documentType",
      label: "Document type",
      proposal: documentType
    });
  for (const [key, measurement] of Object.entries(
    model.proposedFields?.measurements ?? {}
  ))
    rows.push({
      name: measurementUnresolvedName(key),
      label: key,
      proposal: measurement
    });
  return rows;
}

export function formatProposal(proposal: ProposedField): string {
  return "unit" in proposal
    ? `${proposal.value} ${proposal.unit}`
    : String(proposal.value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : []
    )
  );
}

const states: IntakeState[] = [
  "captured",
  "extracting",
  "needs-review",
  "ready",
  "failed"
];

/** Shapes the worker's intake record for the review page, keeping saved
 * corrections visible over new proposals and never trusting field names. */
export function intakeReviewModel(raw: unknown): IntakeReviewModel {
  const intake = record(record(raw).intake);
  const decisions = record(intake.reviewDecisions);
  const corrected = Object.fromEntries(
    Object.entries(decisions).flatMap(([field, decision]) => {
      const value = record(decision).value;
      return typeof value === "string" ? [[field, value]] : [];
    })
  );
  const itemDecision = record(decisions.item);
  const item = itemAssociationSchema.safeParse(itemDecision.value);
  const evidence = Object.entries(
    record(record(intake.extractionOutput).evidence)
  )
    .flatMap(([field, entries]) =>
      Array.isArray(entries)
        ? entries.flatMap((entry) => {
            const value = record(entry);
            return typeof value.page === "number" &&
              typeof value.text === "string"
              ? [
                  {
                    field,
                    page: value.page,
                    text: value.text,
                    ...(typeof value.region === "string"
                      ? { region: value.region }
                      : {})
                  }
                ]
              : [];
          })
        : []
    )
    .slice(0, 200);
  const inputRefs = Array.isArray(intake.inputRefs) ? intake.inputRefs : [];
  const acquiredFrom = inputRefs
    .map((entry) => record(entry).acquiredFrom)
    .find((value): value is string => typeof value === "string");
  const proposed = stringRecord(intake.extraction);
  // A version-1 generation has no typed proposals; a malformed one renders none.
  const proposedFields = proposedFieldsSchema.safeParse(
    record(intake.extractionOutput).proposed
  );
  const state = states.includes(intake.state as IntakeState)
    ? (intake.state as IntakeState)
    : "captured";
  return {
    id: typeof intake.id === "string" ? intake.id : "",
    version:
      typeof intake.version === "string" || typeof intake.version === "number"
        ? String(intake.version)
        : undefined,
    generation:
      typeof intake.generation === "string" ||
      typeof intake.generation === "number"
        ? String(intake.generation)
        : undefined,
    state,
    published: "__published" in decisions,
    title: corrected.title ?? proposed.title ?? "",
    proposed,
    corrected,
    ...(proposedFields.success ? { proposedFields: proposedFields.data } : {}),
    unresolved: Array.isArray(intake.unresolved)
      ? intake.unresolved.filter(
          (field): field is string => typeof field === "string"
        )
      : [],
    evidence,
    item: item.success ? item.data : null,
    itemDecided: "item" in decisions,
    ...(acquiredFrom ? { acquiredFrom } : {})
  };
}

/** What the review form posts: the five bounded fields plus one item or none. */
export const reviewSubmissionSchema = z
  .object({
    metadata: manualMetadataSchema,
    item: itemAssociationSchema.nullable()
  })
  .strict();
