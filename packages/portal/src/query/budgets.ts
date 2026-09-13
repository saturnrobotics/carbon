/**
 * The hard per-request budgets of the interactive read path (plan §1.7).
 * Every number here is a ceiling enforced in code, not a tuning hint: the
 * router, evidence assembly, the answer provider and the conversation store
 * read the same frozen object, so no caller can widen one stage on its own.
 */
export const QUERY_BUDGETS = Object.freeze({
  /** Characters of user text accepted at the wire (the schema enforces it). */
  inputCharacters: 8000,
  /** Model tokens of user text; longer input is a validation response. */
  inputTokens: 2000,
  /** Model context: prompt, conversation state and evidence together. */
  contextTokens: 8000,
  /** Reserved inside the context for compact conversation state. */
  conversationReserveTokens: 1000,
  /** What remains for evidence once the reserve is held back. */
  evidenceTokens: 7000,
  /** Output tokens for one answer; broader reports are explicit async jobs. */
  outputTokens: 800,
  /** Candidates per source, sources per request, final evidence blocks. */
  candidatesPerSource: 40,
  sourcesPerRequest: 4,
  evidenceBlocks: 8,
  /** Evidence references a conversation may carry between requests. */
  conversationEvidence: 8,
  /** Deadlines: one live source, retrieval orchestration, the whole response. */
  sourceDeadlineMs: 1000,
  retrievalDeadlineMs: 2000,
  requestDeadlineMs: 10000
});
export type QueryBudgets = typeof QUERY_BUDGETS;

/**
 * A deliberately conservative token count: UTF-8 bytes never undercount
 * model tokens for the tokenizers in use, so a budget checked against it is
 * a ceiling. Exact provider counts, where a provider offers them, replace it
 * at the provider boundary and are checked against the same limits.
 */
export function conservativeTokenCount(text: string): number {
  return new TextEncoder().encode(text).length;
}

export class BudgetExceededError extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(`${stage} budget exceeded`);
    this.name = "BudgetExceededError";
    this.stage = stage;
  }
}

type LedgerStage = "input" | "evidence" | "context" | "output";

export type TokenLedger = {
  /** Records a spend; throws before the ceiling is crossed. */
  charge(stage: LedgerStage, tokens: number): void;
  /** Tokens spent so far per stage; a snapshot, never the live record. */
  spent(): Readonly<Record<LedgerStage, number>>;
};

/** Token accounting for one request against the frozen ceilings. */
export function createTokenLedger(
  budgets: Pick<
    QueryBudgets,
    "inputTokens" | "evidenceTokens" | "contextTokens" | "outputTokens"
  > = QUERY_BUDGETS
): TokenLedger {
  const limits: Record<LedgerStage, number> = {
    input: budgets.inputTokens,
    evidence: budgets.evidenceTokens,
    context: budgets.contextTokens,
    output: budgets.outputTokens
  };
  const spent: Record<LedgerStage, number> = {
    input: 0,
    evidence: 0,
    context: 0,
    output: 0
  };
  return {
    charge(stage, tokens) {
      if (!Number.isInteger(tokens) || tokens < 0)
        throw new Error("Invalid token accounting");
      if (spent[stage] + tokens > limits[stage])
        throw new BudgetExceededError(stage);
      spent[stage] += tokens;
    },
    spent: () => ({ ...spent })
  };
}

/**
 * Keeps the leading items that fit the token budget, in the order given.
 * Deterministic and order-preserving: a block that does not fit is dropped
 * and later, smaller blocks may still be taken, exactly as evidence assembly
 * does, so the same candidates always produce the same context.
 */
export function fitEvidenceToBudget<T>(
  items: readonly T[],
  options: {
    maxBlocks?: number;
    maxTokens?: number;
    tokensOf: (item: T) => number;
  }
): T[] {
  const maxBlocks = options.maxBlocks ?? QUERY_BUDGETS.evidenceBlocks;
  const maxTokens = options.maxTokens ?? QUERY_BUDGETS.evidenceTokens;
  const kept: T[] = [];
  let tokens = 0;
  for (const item of items) {
    if (kept.length === maxBlocks) break;
    const count = options.tokensOf(item);
    if (!Number.isInteger(count) || count < 0)
      throw new Error("Invalid token accounting");
    if (tokens + count > maxTokens) continue;
    kept.push(item);
    tokens += count;
  }
  return kept;
}
