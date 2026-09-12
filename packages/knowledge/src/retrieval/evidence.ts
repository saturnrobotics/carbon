import { type Evidence, evidenceSchema } from "../contracts";
import type { RetrievedChunk } from "./lexical.server";

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
  if (chunks.length > 40 || options.maxTokens < 1 || options.maxTokens > 7000)
    throw new Error("Invalid evidence budget");
  const evidence: Evidence[] = [];
  let tokens = 0;
  for (const chunk of chunks) {
    if (evidence.length === 8) break;
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
        freshness: "current"
      })
    );
    tokens += count;
  }
  return evidence;
}
