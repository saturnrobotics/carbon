import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import type { Pool, PoolClient, PoolConfig } from "pg";

export function portalPoolConfig(config: PoolConfig): PoolConfig {
  if (!config.connectionString) return config;
  let url: URL;
  try {
    url = new URL(config.connectionString);
  } catch {
    throw new Error("Invalid Portal database URL");
  }
  const sslParameters = [
    "ssl",
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "uselibpqcompat"
  ];
  for (const parameter of sslParameters) {
    if (url.searchParams.getAll(parameter).length > 1) {
      throw new Error("Duplicate Portal database TLS parameter");
    }
  }
  if (url.searchParams.get("sslmode") !== "verify-full") return config;

  // pg upgrades an existing socket and omits servername for IPs. Supplying host
  // makes Node verify the actual IP SAN instead of its default localhost.
  const hostOverride = url.searchParams.getAll("host").at(-1);
  let host: string;
  try {
    host = hostOverride || decodeURIComponent(url.hostname);
  } catch {
    throw new Error("Invalid Portal database host");
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host || host.startsWith("/"))
    throw new Error("Portal verify-full requires a network host");
  const ssl: ConnectionOptions = { host, rejectUnauthorized: true };
  for (const [parameter, option] of [
    ["sslrootcert", "ca"],
    ["sslcert", "cert"],
    ["sslkey", "key"]
  ] as const) {
    const path = url.searchParams.get(parameter);
    if (path) ssl[option] = readFileSync(path, "utf8");
  }
  // Otherwise pg's URL parser replaces the explicit TLS options, losing host.
  for (const parameter of sslParameters) url.searchParams.delete(parameter);
  url.searchParams.set("host", host);
  return { ...config, connectionString: url.toString(), ssl };
}

export type DatabasePrincipal = {
  companyId: string;
  actorId?: string;
  callerId: string;
  sourceId?: string;
};

/** Call only after workforce/service verification. A fresh pool lease bounds claims. */
export async function withPortalTransaction<T>(
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
      "SELECT set_config('portal.company_id',$1,true), set_config('portal.actor_id',$2,true), set_config('portal.caller_id',$3,true), set_config('statement_timeout','2000',true), set_config('portal.source_id',$4,true)",
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
