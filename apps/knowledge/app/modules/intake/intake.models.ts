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
  unresolved: string[];
  sourcePages: Array<{ page: number; text: string }>;
};

export function displayField(model: IntakeReviewModel, field: string) {
  return model.corrected[field] ?? model.proposed[field] ?? "";
}

import { z } from "zod";

export const manualMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    manufacturer: z.string().trim().max(256),
    partNumber: z.string().trim().max(256),
    revision: z.string().trim().max(256),
    machine: z.string().trim().max(256)
  })
  .strict();
