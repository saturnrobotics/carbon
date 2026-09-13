import type { PoolClient } from "pg";
import type { PolicySnapshot } from "./cache.server";

/** Read on each delivery. All-source epochs safely invalidate newly matching rows. */
export async function currentPolicySnapshot(
  client: PoolClient,
  sourceIds: readonly string[]
): Promise<PolicySnapshot> {
  if (sourceIds.length === 0 || sourceIds.length > 4)
    throw new Error("Invalid source scope");
  const bindings = await client.query<{
    id: string;
    revocationVersion: string;
  }>(`SELECT id,"revocationVersion" FROM portal."identityBinding"
    WHERE "companyId"=portal.company_id() AND "canonicalUserId"=portal.actor_id() AND active ORDER BY id`);
  if (!bindings.rows.length)
    return { allowed: false, policyVersion: "denied", epochs: {} };
  const sources = await client.query<{
    id: string;
    contentEpoch: string;
    aclEpoch: string;
  }>(
    `SELECT id,"contentEpoch","aclEpoch" FROM portal.source
    WHERE "companyId"=portal.company_id() AND id=ANY($1::text[]) AND status='active' ORDER BY id`,
    [sourceIds]
  );
  if (sources.rows.length !== new Set(sourceIds).size)
    return { allowed: false, policyVersion: "denied", epochs: {} };
  return {
    allowed: true,
    policyVersion: bindings.rows
      .map((row) => `${row.id}:${row.revocationVersion}`)
      .join("|"),
    epochs: Object.fromEntries(
      sources.rows.flatMap((row) => [
        [`${row.id}:content`, row.contentEpoch],
        [`${row.id}:acl`, row.aclEpoch]
      ])
    )
  };
}

/**
 * Outbox kinds whose only required effect on the query path is invalidation.
 * Database triggers already bump epochs for local table writes; these events
 * carry changes the triggers never see (connector deletes, external ACL and
 * board changes, corrections, and new index generations).
 */
export const INVALIDATION_EVENT_TYPES = [
  "acl-change",
  "board-change",
  "delete",
  "correction",
  "index-version"
] as const;
export type InvalidationEventType = (typeof INVALIDATION_EVENT_TYPES)[number];

const ACL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "acl-change",
  "board-change"
]);

export type SourceEpochBump = {
  sourceId: string;
  acl: boolean;
  content: boolean;
};

export function isInvalidationEventType(
  value: string
): value is InvalidationEventType {
  return (INVALIDATION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Collapses a delivered batch into at most one bump per source and epoch kind.
 * The result depends only on the set of (source, kind) pairs, never on delivery
 * order or duplicates, and revocations (ACL bumps) sort first.
 */
export function planInvalidation(
  events: ReadonlyArray<{ sourceId: string; eventType: string }>
): SourceEpochBump[] {
  const bySource = new Map<string, SourceEpochBump>();
  for (const event of events) {
    if (!isInvalidationEventType(event.eventType)) continue;
    const bump = bySource.get(event.sourceId) ?? {
      sourceId: event.sourceId,
      acl: false,
      content: false
    };
    if (ACL_EVENT_TYPES.has(event.eventType)) bump.acl = true;
    else bump.content = true;
    bySource.set(event.sourceId, bump);
  }
  return [...bySource.values()].sort(
    (left, right) =>
      Number(right.acl) - Number(left.acl) ||
      left.sourceId.localeCompare(right.sourceId, "en")
  );
}

/**
 * Advances source epochs in one statement under the ingestion role's row policy.
 * Epochs are monotonic counters, so re-applying a bump after a lost lease only
 * invalidates again; it can never resurrect an older cache entry.
 */
export async function bumpSourceEpochs(
  client: PoolClient,
  companyId: string,
  plan: readonly SourceEpochBump[]
): Promise<
  Array<{ sourceId: string; contentEpoch: string; aclEpoch: string }>
> {
  const effective = plan.filter((bump) => bump.acl || bump.content);
  if (!effective.length) return [];
  if (effective.length > 100) throw new Error("Invalidation batch too large");
  const result = await client.query<{
    sourceId: string;
    contentEpoch: string;
    aclEpoch: string;
  }>(
    `UPDATE portal.source s
       SET "aclEpoch"=s."aclEpoch"+CASE WHEN p.acl THEN 1 ELSE 0 END,
           "contentEpoch"=s."contentEpoch"+CASE WHEN p.content THEN 1 ELSE 0 END,
           version=s.version+1,"updatedAt"=clock_timestamp()
       FROM unnest($2::text[],$3::boolean[],$4::boolean[]) AS p(id,acl,content)
       WHERE s."companyId"=$1 AND s.id=p.id AND s.status='active'
       RETURNING s.id AS "sourceId",s."contentEpoch",s."aclEpoch"`,
    [
      companyId,
      effective.map((bump) => bump.sourceId),
      effective.map((bump) => bump.acl),
      effective.map((bump) => bump.content)
    ]
  );
  if (result.rows.length !== new Set(effective.map((b) => b.sourceId)).size)
    throw new Error("Invalidation target source is not writable");
  return result.rows;
}
