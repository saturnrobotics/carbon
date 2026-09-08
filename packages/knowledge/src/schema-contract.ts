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
export const KNOWLEDGE_RUNTIME_ROLES = [
  "knowledge_read",
  "knowledge_ingest",
  "knowledge_review",
  "knowledge_actions",
  "knowledge_maintenance"
] as const;
export function validateEmbedding(value: readonly number[]): void {
  if (
    value.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
    value.some((component) => !Number.isFinite(component))
  ) {
    throw new Error("Embedding must contain exactly 768 finite components");
  }
}
