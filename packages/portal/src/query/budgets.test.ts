import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  conservativeTokenCount,
  createTokenLedger,
  fitEvidenceToBudget,
  QUERY_BUDGETS
} from "./budgets";

describe("hard query budgets", () => {
  it("is frozen and internally consistent", () => {
    expect(Object.isFrozen(QUERY_BUDGETS)).toBe(true);
    expect(
      QUERY_BUDGETS.contextTokens - QUERY_BUDGETS.conversationReserveTokens
    ).toBe(QUERY_BUDGETS.evidenceTokens);
    expect(QUERY_BUDGETS.conversationEvidence).toBe(
      QUERY_BUDGETS.evidenceBlocks
    );
    expect(() => {
      (QUERY_BUDGETS as { outputTokens: number }).outputTokens = 100_000;
    }).toThrow(TypeError);
    expect(QUERY_BUDGETS.outputTokens).toBe(800);
  });
  it("counts tokens conservatively, never below the byte length", () => {
    expect(conservativeTokenCount("")).toBe(0);
    expect(conservativeTokenCount("abcd")).toBe(4);
    expect(conservativeTokenCount("N·m")).toBeGreaterThan(3);
  });
  it("refuses a charge that would cross a ceiling and keeps the ledger unchanged", () => {
    const ledger = createTokenLedger();
    ledger.charge("evidence", 6999);
    ledger.charge("evidence", 1);
    expect(() => ledger.charge("evidence", 1)).toThrow(BudgetExceededError);
    expect(ledger.spent().evidence).toBe(QUERY_BUDGETS.evidenceTokens);
    expect(() => ledger.charge("output", 801)).toThrow(
      "output budget exceeded"
    );
    expect(() => ledger.charge("input", -1)).toThrow(
      "Invalid token accounting"
    );
    expect(() => ledger.charge("context", 1.5)).toThrow(
      "Invalid token accounting"
    );
  });
  it("fits evidence deterministically within blocks and tokens, in order", () => {
    const items = [
      { id: "a", tokens: 4000 },
      { id: "b", tokens: 4000 },
      { id: "c", tokens: 2000 },
      { id: "d", tokens: 500 }
    ];
    const kept = fitEvidenceToBudget(items, {
      tokensOf: (item) => item.tokens
    });
    expect(kept.map((item) => item.id)).toEqual(["a", "c", "d"]);
    expect(
      fitEvidenceToBudget(items, {
        maxBlocks: 2,
        tokensOf: (item) => item.tokens
      }).map((item) => item.id)
    ).toEqual(["a", "c"]);
    expect(() =>
      fitEvidenceToBudget(items, { tokensOf: () => Number.NaN })
    ).toThrow("Invalid token accounting");
  });
});
