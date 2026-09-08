import type { Pool, PoolClient } from "pg";

export type DatabasePrincipal = {
  companyId: string;
  actorId?: string;
  callerId: string;
  sourceId?: string;
};

/** Call only after workforce/service verification. A fresh pool lease bounds claims. */
export async function withKnowledgeTransaction<T>(
  pool: Pool,
  principal: DatabasePrincipal,
  access: "read" | "write",
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!principal.companyId || !principal.callerId)
    throw new Error("Verified database principal required");
  const client = await pool.connect();
  try {
    await client.query(access === "read" ? "BEGIN READ ONLY" : "BEGIN");
    await client.query(
      "SELECT set_config('knowledge.company_id',$1,true), set_config('knowledge.actor_id',$2,true), set_config('knowledge.caller_id',$3,true), set_config('statement_timeout','2000',true), set_config('knowledge.source_id',$4,true)",
      [
        principal.companyId,
        principal.actorId ?? "",
        principal.callerId,
        principal.sourceId ?? ""
      ]
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
