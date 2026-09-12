/** Reviewed private-schema lifecycle contract, independently versioned from Carbon. */
export const KNOWLEDGE_SCHEMA_VERSION = 1;
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 768;
export const KNOWLEDGE_TABLES = [
  "source",
  "identityBinding",
  "sourceUserBinding",
  "document",
  "documentVersion",
  "chunk",
  "entity",
  "entityLink",
  "grant",
  "groupMembership",
  "intake",
  "extraction",
  "outbox",
  "command",
  "conversation",
  "audit"
] as const;
/** Non-tenant metadata tables: no companyId, no row policies, owner-only access. */
export const KNOWLEDGE_METADATA_TABLES = ["extensionVersion"] as const;
export const KNOWLEDGE_RUNTIME_ROLES = [
  "knowledge_read",
  "knowledge_ingest",
  "knowledge_review",
  "knowledge_actions",
  "knowledge_maintenance"
] as const;
/**
 * Extensions the retrieval functions depend on. The installed version is
 * recorded in knowledge."extensionVersion" at migration time and re-checked
 * on every migration run; `iterativeScanVersion` is the pgvector release that
 * added `hnsw.iterative_scan`, which `knowledge.search_vector_ann` requires
 * before it ranks through the index instead of the exact baseline.
 */
export const KNOWLEDGE_EXTENSIONS = [
  { name: "vector", minimumVersion: "0.5.0", iterativeScanVersion: "0.8.0" }
] as const;
export type KnowledgeExtensionName =
  (typeof KNOWLEDGE_EXTENSIONS)[number]["name"];

const extensionVersionPattern = /^[0-9]+(\.[0-9]+)*$/;

/** Numeric dotted-version order; mirrors knowledge.extension_at_least(). */
export function compareExtensionVersions(left: string, right: string): number {
  if (
    !extensionVersionPattern.test(left) ||
    !extensionVersionPattern.test(right)
  )
    throw new Error("Extension versions must be dotted integers");
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function supportsIterativeScan(vectorVersion: string): boolean {
  return (
    compareExtensionVersions(
      vectorVersion,
      KNOWLEDGE_EXTENSIONS[0].iterativeScanVersion
    ) >= 0
  );
}

export function validateEmbedding(value: readonly number[]): void {
  if (
    value.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
    value.some((component) => !Number.isFinite(component))
  ) {
    throw new Error("Embedding must contain exactly 768 finite components");
  }
}
