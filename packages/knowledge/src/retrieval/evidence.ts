import { type Evidence, evidenceSchema } from "../contracts";
import { QUERY_BUDGETS } from "../query/budgets";
import type { RetrievedChunk } from "./lexical.server";

export const MAX_EVIDENCE_BLOCKS = QUERY_BUDGETS.evidenceBlocks;
export const MAX_EVIDENCE_CANDIDATES = QUERY_BUDGETS.candidatesPerSource;

/**
 * Order evidence candidates deterministically: every selected chunk first, in
 * rank order, then each chunk's parent section, then grandparents, and so on.
 * Ancestors never displace a selected chunk, a section already selected or
 * already added is not repeated, and an ancestor inherits the retrieval path
 * of the chunk it explains. The caller still applies the block and token caps.
 */
export function planSectionExpansion(
  selected: readonly RetrievedChunk[],
  lineage: ReadonlyMap<string, readonly RetrievedChunk[]>
): RetrievedChunk[] {
  const ordered: RetrievedChunk[] = [];
  const seen = new Set<string>();
  for (const chunk of selected) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    ordered.push(chunk);
  }
  const deepest = Math.max(
    0,
    ...[...lineage.values()].map((ancestors) => ancestors.length)
  );
  for (let depth = 0; depth < deepest; depth += 1) {
    for (const chunk of selected) {
      const ancestor = lineage.get(chunk.id)?.[depth];
      if (!ancestor || seen.has(ancestor.id)) continue;
      if (ancestor.documentVersionId !== chunk.documentVersionId)
        throw new Error("Section expansion crossed a document version");
      seen.add(ancestor.id);
      ordered.push({
        ...ancestor,
        retrievalPath: ancestor.retrievalPath ?? chunk.retrievalPath
      });
    }
  }
  return ordered;
}

/**
 * Evidence is what the READER may see. Provider eligibility is decided
 * separately at the provider boundary (`../provider-policy.ts`), never here: an
 * ineligible document is still the reader's evidence.
 */
export async function assembleEvidence(
  chunks: readonly RetrievedChunk[],
  options: {
    origin: string;
    policyVersion: string;
    maxTokens: number;
    countTokens: (text: string) => number;
    authorize: (chunk: RetrievedChunk) => Promise<boolean>;
    /** Parent-section lineage for the selected chunks, nearest ancestor first. */
    expandSections?: (
      selected: readonly RetrievedChunk[]
    ) => Promise<ReadonlyMap<string, readonly RetrievedChunk[]>>;
  }
): Promise<Evidence[]> {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid evidence origin");
  if (
    chunks.length > MAX_EVIDENCE_CANDIDATES ||
    options.maxTokens < 1 ||
    options.maxTokens > QUERY_BUDGETS.evidenceTokens
  )
    throw new Error("Invalid evidence budget");
  const candidates = options.expandSections
    ? planSectionExpansion(chunks, await options.expandSections(chunks))
    : chunks;
  const evidence: Evidence[] = [];
  let tokens = 0;
  for (const chunk of candidates) {
    if (evidence.length === MAX_EVIDENCE_BLOCKS) break;
    // Authorization (including live Drive access) precedes delivery.
    if (!(await options.authorize(chunk))) continue;
    const count = options.countTokens(chunk.text);
    if (!Number.isInteger(count) || count < 0)
      throw new Error("Invalid token accounting");
    if (tokens + count > options.maxTokens) continue;
    const sourceUri = new URL(
      `/documents/${encodeURIComponent(chunk.documentId)}/versions/${encodeURIComponent(chunk.documentVersionId)}`,
      origin
    );
    if (chunk.page) sourceUri.hash = `page=${chunk.page}`;
    evidence.push(
      evidenceSchema.parse({
        id: chunk.id,
        sourceId: chunk.sourceId,
        documentVersionId: chunk.documentVersionId,
        sourceRevision: chunk.sourceRevision,
        title: chunk.title,
        excerpt: chunk.text,
        ...(chunk.page ? { page: chunk.page } : {}),
        ...(chunk.heading ? { section: chunk.heading } : {}),
        sourceUri: sourceUri.toString(),
        observedAt: chunk.observedAt,
        policyVersion: options.policyVersion,
        freshness: "current",
        ...(chunk.retrievalPath ? { retrievalPath: chunk.retrievalPath } : {})
      })
    );
    tokens += count;
  }
  return evidence;
}
