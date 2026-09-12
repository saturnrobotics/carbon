import type { ItemCandidate } from "@carbon/knowledge";
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
  unresolved: string[];
  evidence: IntakeEvidence[];
  item: ItemAssociation | null;
  /** Whether a reviewer already answered the item question (even with "none"). */
  itemDecided: boolean;
  acquiredFrom?: string;
};

export function displayField(model: IntakeReviewModel, field: string) {
  return model.corrected[field] ?? model.proposed[field] ?? "";
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
