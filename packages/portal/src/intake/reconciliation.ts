import type { Extraction, ProposedFieldName } from "./contracts";

export type ReviewDecision = {
  value: unknown;
  decision: "accepted" | "corrected" | "rejected";
  evidence: readonly string[];
};

/**
 * Review decisions are keyed by the reviewed metadata names; typed proposals
 * use the parser's names. `partNumber` is the reviewer's word for `mpn`.
 */
export const PROPOSED_FIELD_FOR_DECISION: Readonly<
  Record<string, ProposedFieldName>
> = {
  title: "title",
  manufacturer: "manufacturer",
  partNumber: "mpn",
  mpn: "mpn",
  revision: "revision",
  documentType: "documentType"
};

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Keep reviewer choices authoritative; new evidence asks for acknowledgement.
 *
 * The parser's proposals stay exactly as extracted (they are the immutable
 * generation), the reviewer's value is carried in `fields`, and a field is
 * unresolved only when the new generation actually proposes something that
 * disagrees with the decision. A field the parser no longer emits is not new
 * evidence, so the correction carries over silently.
 */
export function reconcileExtraction(
  previous: Extraction,
  next: Extraction,
  decisions: Readonly<Record<string, ReviewDecision>>
): Extraction {
  const fields = { ...next.fields };
  const unresolved = new Set(next.unresolved);
  for (const [field, decision] of Object.entries(decisions)) {
    if (decision.decision === "rejected") continue;
    if (!sameValue(next.fields[field], decision.value)) {
      fields[field] = decision.value;
      if (field in next.fields) unresolved.add(field);
    }
    const proposedName = PROPOSED_FIELD_FOR_DECISION[field];
    const proposal = proposedName ? next.proposed[proposedName] : undefined;
    if (proposedName && proposal && !sameValue(proposal.value, decision.value))
      unresolved.add(proposedName);
  }
  return {
    ...next,
    fields,
    unresolved: [...unresolved].sort(),
    warnings: [...new Set([...previous.warnings, ...next.warnings])]
  };
}
