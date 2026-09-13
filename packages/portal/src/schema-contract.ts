/** Reviewed private-schema lifecycle contract, independently versioned from Carbon. */
export const PORTAL_SCHEMA_VERSION = 1;
export const PORTAL_EMBEDDING_DIMENSIONS = 768;
export const PORTAL_TABLES = [
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
  "audit",
  "driveEnrollment",
  "driveItem"
] as const;
/** Non-tenant metadata tables: no companyId, no row policies, owner-only access. */
export const PORTAL_METADATA_TABLES = ["extensionVersion"] as const;
export const PORTAL_RUNTIME_ROLES = [
  "portal_read",
  "portal_ingest",
  "portal_review",
  "portal_actions",
  "portal_maintenance"
] as const;
/**
 * Extensions the retrieval functions depend on. The installed version is
 * recorded in portal."extensionVersion" at migration time and re-checked
 * on every migration run; `iterativeScanVersion` is the pgvector release that
 * added `hnsw.iterative_scan`, which `portal.search_vector_ann` requires
 * before it ranks through the index instead of the exact baseline.
 */
export const PORTAL_EXTENSIONS = [
  { name: "vector", minimumVersion: "0.5.0", iterativeScanVersion: "0.8.0" }
] as const;
export type PortalExtensionName = (typeof PORTAL_EXTENSIONS)[number]["name"];

const extensionVersionPattern = /^[0-9]+(\.[0-9]+)*$/;

/** Numeric dotted-version order; mirrors portal.extension_at_least(). */
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
      PORTAL_EXTENSIONS[0].iterativeScanVersion
    ) >= 0
  );
}

export function validateEmbedding(value: readonly number[]): void {
  if (
    value.length !== PORTAL_EMBEDDING_DIMENSIONS ||
    value.some((component) => !Number.isFinite(component))
  ) {
    throw new Error("Embedding must contain exactly 768 finite components");
  }
}
