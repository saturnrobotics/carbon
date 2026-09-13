import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { compareExtensionVersions, PORTAL_EXTENSIONS } from "./schema-contract";

export type ExtensionVersionReport = {
  name: string;
  installed: string;
  recorded: string;
  changed: boolean;
};

/**
 * Compare every required extension's installed version with the version the
 * migrations recorded. A missing extension or one below the minimum refuses
 * to start; a changed version is re-recorded as seen at startup so the change
 * is visible in the table and in the migration log rather than silently
 * altering retrieval behaviour.
 */
export async function verifyPortalExtensions(
  client: PoolClient
): Promise<ExtensionVersionReport[]> {
  const reports: ExtensionVersionReport[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE portal_migrate");
    for (const extension of PORTAL_EXTENSIONS) {
      const installed = await client.query<{ version: string }>(
        "SELECT extversion AS version FROM pg_catalog.pg_extension WHERE extname=$1",
        [extension.name]
      );
      const installedVersion = installed.rows[0]?.version;
      if (!installedVersion)
        throw new Error(
          `Required extension is not installed: ${extension.name}`
        );
      if (
        compareExtensionVersions(installedVersion, extension.minimumVersion) < 0
      )
        throw new Error(
          `Extension ${extension.name} ${installedVersion} is below the required ${extension.minimumVersion}`
        );
      const recorded = await client.query<{ version: string }>(
        'SELECT version FROM portal."extensionVersion" WHERE name=$1',
        [extension.name]
      );
      const recordedVersion = recorded.rows[0]?.version;
      if (!recordedVersion)
        throw new Error(
          `Extension version was never recorded: ${extension.name}`
        );
      const changed = recordedVersion !== installedVersion;
      if (changed)
        await client.query(
          'UPDATE portal."extensionVersion" SET version=$2,"recordedBy"=$3,"recordedAt"=now() WHERE name=$1',
          [extension.name, installedVersion, "startup"]
        );
      reports.push({
        name: extension.name,
        installed: installedVersion,
        recorded: recordedVersion,
        changed
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return reports;
}

/** One connection and advisory lock cover checksum checks and every applied file. */
export async function applyPortalMigrations(
  client: PoolClient,
  directory: string
): Promise<{ applied: string[]; extensions: ExtensionVersionReport[] }> {
  const applied: string[] = [];
  const ledger = async (): Promise<
    "knowledge_migrations" | "portal_migrations"
  > => {
    const result = await client.query<{ legacy: boolean; portal: boolean }>(
      "SELECT to_regnamespace('knowledge_migrations') IS NOT NULL AS legacy, to_regnamespace('portal_migrations') IS NOT NULL AS portal"
    );
    const state = result.rows[0];
    if (state?.legacy && state.portal)
      throw new Error("Both legacy and Portal migration ledgers exist");
    return state?.portal ? "portal_migrations" : "knowledge_migrations";
  };
  await client.query("SELECT pg_advisory_lock(714203, 1)");
  try {
    let schema = await ledger();
    const publicRename = await client.query<{ ready: boolean }>(
      "SELECT to_regprocedure('public.portal_resolve_workforce_identity(text,text,text)') IS NOT NULL AS ready"
    );
    if (!publicRename.rows[0]?.ready)
      throw new Error(
        "Apply the Carbon Portal public-identifiers migration before private Portal migrations"
      );
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema};
      REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS ${schema}.ledger (
        name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      ); REVOKE ALL ON ${schema}.ledger FROM PUBLIC`);
    const files = (await readdir(directory))
      .filter((name) => /^\d{14}_[a-z0-9-]+\.sql$/.test(name))
      .sort();
    if (files.length === 0) throw new Error("No Portal migrations found");
    for (const name of files) {
      const body = await readFile(resolve(directory, name), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const previous = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${schema}.ledger WHERE name=$1`,
        [name]
      );
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        // Historical SQL validates and invokes the old source-owned resolver.
        // Recreate its bridge only inside each legacy migration transaction:
        // no success or rollback changes Carbon's persistent public API/types.
        const historicalBridge = schema === "knowledge_migrations";
        if (historicalBridge) {
          await client.query(`CREATE FUNCTION public.knowledge_resolve_workforce_identity(
            requested_issuer text,requested_subject text,requested_company_id text
          ) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
          AS $$ SELECT public.portal_resolve_workforce_identity(requested_issuer,requested_subject,requested_company_id) $$;
          REVOKE ALL ON FUNCTION public.knowledge_resolve_workforce_identity(text,text,text) FROM PUBLIC,anon,authenticated;
          GRANT EXECUTE ON FUNCTION public.knowledge_resolve_workforce_identity(text,text,text) TO knowledge_read,knowledge_migrate`);
        }
        await client.query(body);
        if (historicalBridge) {
          await client.query("RESET ROLE");
          if (name === "20260911204358_workforce-identity-enrollment.sql")
            await client.query(
              "GRANT EXECUTE ON FUNCTION public.portal_resolve_workforce_identity(text,text,text) TO knowledge_enrollment_owner"
            );
          await client.query(
            "DROP FUNCTION IF EXISTS public.knowledge_resolve_workforce_identity(text,text,text)"
          );
        }
        schema = await ledger();
        const owner =
          schema === "portal_migrations"
            ? "portal_migrate"
            : "knowledge_migrate";
        await client.query(
          `ALTER SCHEMA ${schema} OWNER TO ${owner}; ALTER TABLE ${schema}.ledger OWNER TO ${owner}`
        );
        await client.query(
          `INSERT INTO ${schema}.ledger(name,checksum) VALUES ($1,$2)`,
          [name, checksum]
        );
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    if (schema !== "portal_migrations")
      throw new Error("Portal identifier migration did not complete");
    await client.query(
      "ALTER SCHEMA portal_migrations OWNER TO portal_migrate; ALTER TABLE portal_migrations.ledger OWNER TO portal_migrate"
    );
    const extensions = await verifyPortalExtensions(client);
    return { applied, extensions };
  } finally {
    await client.query("SELECT pg_advisory_unlock(714203, 1)");
  }
}
