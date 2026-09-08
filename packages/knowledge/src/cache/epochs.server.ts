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
  }>(`SELECT id,"revocationVersion" FROM knowledge."identityBinding"
    WHERE "companyId"=knowledge.company_id() AND "canonicalUserId"=knowledge.actor_id() AND active ORDER BY id`);
  if (!bindings.rows.length)
    return { allowed: false, policyVersion: "denied", epochs: {} };
  const sources = await client.query<{
    id: string;
    contentEpoch: string;
    aclEpoch: string;
  }>(
    `SELECT id,"contentEpoch","aclEpoch" FROM knowledge.source
    WHERE "companyId"=knowledge.company_id() AND id=ANY($1::text[]) AND status='active' ORDER BY id`,
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
