import { createHash } from "node:crypto";
import type { CacheStore } from "@carbon/knowledge/cache";
import {
  type ConversationPrincipal,
  type ConversationState,
  conversationStateSchema,
  MAX_CONVERSATION_EVIDENCE,
  reauthorizeConversationState
} from "@carbon/knowledge/query/conversation";

/** How long a follow-up may refer to what the reader was last shown. */
export const CONVERSATION_TTL_SECONDS = 1800;

export type ConversationStore = {
  /** The restored context, or `null` when there is none the current policy allows. */
  load(
    principal: ConversationPrincipal,
    conversationId: string,
    authorizeEvidence: (ids: readonly string[]) => Promise<boolean>
  ): Promise<ConversationState | null>;
  /** Records the evidence just delivered; never blocks or fails a delivery. */
  save(
    principal: ConversationPrincipal,
    conversationId: string,
    evidenceIds: readonly string[]
  ): Promise<void>;
};

function conversationKey(
  principal: ConversationPrincipal,
  conversationId: string
): string {
  // The key is scoped to the verified company and actor, so another reader's
  // conversation id addresses nothing of theirs.
  return `knowledge:conversation:v1:${createHash("sha256")
    .update(
      JSON.stringify([principal.companyId, principal.actorId, conversationId])
    )
    .digest("hex")}`;
}

/**
 * The only follow-up context between requests: evidence identifiers, keyed
 * by the verified principal, re-authorized on every reuse. It is a hint
 * about what the reader was looking at and grants nothing; losing it means
 * the next question simply starts without context.
 */
export function createConversationStore(
  store: CacheStore,
  ttlSeconds = CONVERSATION_TTL_SECONDS
): ConversationStore {
  return {
    async load(principal, conversationId, authorizeEvidence) {
      let stored: unknown;
      try {
        stored = await store.get(conversationKey(principal, conversationId));
      } catch {
        return null;
      }
      if (stored === undefined) return null;
      return reauthorizeConversationState(stored, principal, authorizeEvidence);
    },
    async save(principal, conversationId, evidenceIds) {
      const state = conversationStateSchema.safeParse({
        schema: 1,
        companyId: principal.companyId,
        actorId: principal.actorId,
        policyVersion: principal.policyVersion,
        evidenceIds: [...new Set(evidenceIds)].slice(
          0,
          MAX_CONVERSATION_EVIDENCE
        )
      } satisfies ConversationState);
      if (!state.success) return;
      try {
        await store.set(
          conversationKey(principal, conversationId),
          state.data,
          ttlSeconds
        );
      } catch {
        /* Follow-up context is a convenience; delivery does not depend on it. */
      }
    }
  };
}
