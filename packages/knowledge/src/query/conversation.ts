import { z } from "zod";
import { KNOWLEDGE_LIMITS } from "../contracts";
import { QUERY_BUDGETS } from "./budgets";

/** Matches the authorized cache envelope: a follow-up never references more. */
export const MAX_CONVERSATION_EVIDENCE = QUERY_BUDGETS.conversationEvidence;
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(KNOWLEDGE_LIMITS.idCharacters)
  .regex(/^\S+$/);

/**
 * The only follow-up context a conversation may carry between requests:
 * evidence identifiers, never evidence bodies. Stored state is a hint about
 * what the user was looking at; it grants nothing on its own.
 */
export const conversationStateSchema = z
  .object({
    schema: z.literal(1),
    companyId: opaqueIdSchema,
    actorId: opaqueIdSchema,
    policyVersion: opaqueIdSchema,
    evidenceIds: z.array(opaqueIdSchema).max(MAX_CONVERSATION_EVIDENCE)
  })
  .strict();
export type ConversationState = z.infer<typeof conversationStateSchema>;

export type ConversationPrincipal = {
  companyId: string;
  actorId: string;
  policyVersion: string;
};

/**
 * Restores stored follow-up context only after every evidence reference has
 * been re-authorized for the current principal. Anything else — malformed
 * state, another actor or company, a failed or unavailable policy check —
 * yields `null`, and the caller starts the conversation without context.
 * The evidence set is restored whole or not at all: a partially authorized
 * context would silently change what a follow-up question refers to.
 */
export async function reauthorizeConversationState(
  stored: unknown,
  principal: ConversationPrincipal,
  authorizeEvidence: (ids: readonly string[]) => Promise<boolean>
): Promise<ConversationState | null> {
  const parsed = conversationStateSchema.safeParse(stored);
  if (!parsed.success) return null;
  const state = parsed.data;
  if (
    state.companyId !== principal.companyId ||
    state.actorId !== principal.actorId
  )
    return null;
  const evidenceIds = [...new Set(state.evidenceIds)];
  let authorized = false;
  try {
    authorized =
      evidenceIds.length === 0 || (await authorizeEvidence(evidenceIds));
  } catch {
    authorized = false;
  }
  if (!authorized) return null;
  return { ...state, evidenceIds, policyVersion: principal.policyVersion };
}
