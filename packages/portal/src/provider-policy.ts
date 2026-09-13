import type { RetrievedChunk } from "./retrieval/lexical.server";

/**
 * Provider eligibility is a fact about the SOURCE, recorded in
 * `portal.source."providerPolicy"` and carried on every retrieved chunk. It
 * is independent of the reader's permission: a reader may see text that no
 * provider may, and a provider may be admitted to text a given reader may not
 * see. The empty default `{}` admits nothing.
 */
export type ProviderPolicySubject = Pick<
  RetrievedChunk,
  "classification" | "providerPolicy"
>;

export function providerEligible(
  chunk: ProviderPolicySubject,
  providerId: string
): boolean {
  const providers = chunk.providerPolicy.allowedProviders;
  const classifications = chunk.providerPolicy.allowedClassifications;
  return (
    Array.isArray(providers) &&
    providers.includes(providerId) &&
    Array.isArray(classifications) &&
    classifications.includes(chunk.classification)
  );
}

/** Carries counts only; never a chunk id, title or text. */
export class ProviderPolicyRefusal extends Error {
  readonly providerId: string;
  readonly refusedCount: number;
  constructor(providerId: string, refusedCount: number) {
    super(
      `Provider ${providerId} refused: ${refusedCount} candidate(s) not admitted by source policy`
    );
    this.name = "ProviderPolicyRefusal";
    this.providerId = providerId;
    this.refusedCount = refusedCount;
  }
}

/**
 * A candidate set is disclosed whole or not at all. One ineligible member refuses
 * the provider call; the set is never trimmed to its eligible part, because a
 * trimmed call answers a different question than the reader asked and hides that
 * it did.
 */
export function assertProviderCandidates(
  providerId: string,
  candidates: readonly ProviderPolicySubject[]
): void {
  let refused = 0;
  for (const candidate of candidates)
    if (!providerEligible(candidate, providerId)) refused += 1;
  if (refused > 0) throw new ProviderPolicyRefusal(providerId, refused);
}
