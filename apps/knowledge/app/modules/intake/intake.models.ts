import {
  measurementUnresolvedName,
  type ProposedField,
  type ProposedFields
} from "@carbon/knowledge/intake/contracts";
import { z } from "zod";

export type IntakeState =
  | "captured"
  | "extracting"
  | "needs-review"
  | "ready"
  | "failed";
export type IntakeReviewModel = {
  id: string;
  version?: string;
  generation?: string;
  state: IntakeState;
  title: string;
  proposed: Record<string, string>;
  corrected: Record<string, string>;
  /** Typed proposals from the current extraction generation, when it has any. */
  proposedFields?: ProposedFields;
  unresolved: string[];
  sourcePages: Array<{ page: number; text: string }>;
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

export const manualMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    manufacturer: z.string().trim().max(256),
    partNumber: z.string().trim().max(256),
    revision: z.string().trim().max(256),
    machine: z.string().trim().max(256)
  })
  .strict();
