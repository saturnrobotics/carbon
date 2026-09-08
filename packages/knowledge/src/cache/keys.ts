import { createHash } from "node:crypto";

export type CacheScope = {
  companyId: string;
  actorId: string;
  callerId: string;
  capability: string;
  intent: string;
  entities: string[];
  query: string;
  locale: string;
  businessTimezone: string;
  modelVersion: string;
  promptVersion: string;
  indexVersion: string;
};
export function cacheKey(
  scope: CacheScope,
  snapshot: { policyVersion: string; epochs: Record<string, string> }
): string {
  const canonical = {
    ...scope,
    query: scope.query.normalize("NFC").trim(),
    entities: [...scope.entities].sort(),
    policyVersion: snapshot.policyVersion,
    epochs: Object.fromEntries(
      Object.entries(snapshot.epochs).sort(([a], [b]) =>
        a.localeCompare(b, "en")
      )
    )
  };
  return (
    "knowledge:v1:" +
    createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
  );
}
