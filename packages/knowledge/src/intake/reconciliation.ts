import type { Extraction } from "./contracts";

export type ReviewDecision = {
  value: unknown;
  decision: "accepted" | "corrected" | "rejected";
  evidence: readonly string[];
};

/** Keep reviewer choices authoritative; new evidence asks for acknowledgement. */
export function reconcileExtraction(
  previous: Extraction,
  next: Extraction,
  decisions: Readonly<Record<string, ReviewDecision>>
): Extraction {
  const fields = { ...next.fields };
  const unresolved = new Set(next.unresolved);
  for (const [field, decision] of Object.entries(decisions)) {
    if (decision.decision === "rejected") continue;
    if (JSON.stringify(next.fields[field]) !== JSON.stringify(decision.value)) {
      fields[field] = decision.value;
      unresolved.add(field);
    }
  }
  return {
    ...next,
    fields,
    unresolved: [...unresolved].sort(),
    warnings: [...new Set([...previous.warnings, ...next.warnings])]
  };
}
