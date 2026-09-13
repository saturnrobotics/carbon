import { z } from "zod";
import { evidenceSchema } from "../contracts";
import { QUERY_BUDGETS } from "./budgets";

/**
 * The reader-facing result contract, kept free of server imports so the
 * browser can validate what a stream delivers with the same schema the
 * service produced it from.
 */
export const claimSchema = z
  .object({
    text: z.string().min(1).max(2000),
    evidenceIds: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(QUERY_BUDGETS.evidenceBlocks)
  })
  .strict();
export const synthesisSchema = z
  .object({ claims: z.array(claimSchema).max(12) })
  .strict();
export const queryChoiceSchema = z
  .object({ id: z.string().max(256), label: z.string().max(500) })
  .strict();
export const queryResultSchema = z
  .object({
    requestId: z.string(),
    kind: z.enum([
      "results",
      "answer",
      "abstention",
      "command",
      "clarification"
    ]),
    evidence: z.array(evidenceSchema).max(QUERY_BUDGETS.evidenceBlocks),
    claims: z.array(claimSchema).max(12),
    message: z.string().max(500),
    partial: z.boolean(),
    choices: z.array(queryChoiceSchema).max(20).optional()
  })
  .strict();
export type QueryResult = z.infer<typeof queryResultSchema>;
export type QueryClaim = z.infer<typeof claimSchema>;
