import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import {
  compareExtensionVersions,
  KNOWLEDGE_EXTENSIONS
} from "./schema-contract";

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
export async function verifyKnowledgeExtensions(
  client: PoolClient
): Promise<ExtensionVersionReport[]> {
  const reports: ExtensionVersionReport[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE knowledge_migrate");
    for (const extension of KNOWLEDGE_EXTENSIONS) {
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
        'SELECT version FROM knowledge."extensionVersion" WHERE name=$1',
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
          'UPDATE knowledge."extensionVersion" SET version=$2,"recordedBy"=$3,"recordedAt"=now() WHERE name=$1',
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
export async function applyKnowledgeMigrations(
  client: PoolClient,
  directory: string
): Promise<{ applied: string[]; extensions: ExtensionVersionReport[] }> {
  const applied: string[] = [];
  await client.query("SELECT pg_advisory_lock(714203, 1)");
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS knowledge_migrations;
      REVOKE ALL ON SCHEMA knowledge_migrations FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS knowledge_migrations.ledger (
        name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      ); REVOKE ALL ON knowledge_migrations.ledger FROM PUBLIC`);
    const files = (await readdir(directory))
      .filter((name) => /^\d{14}_[a-z0-9-]+\.sql$/.test(name))
      .sort();
    if (files.length === 0) throw new Error("No knowledge migrations found");
    for (const name of files) {
      const body = await readFile(resolve(directory, name), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const previous = await client.query<{ checksum: string }>(
        "SELECT checksum FROM knowledge_migrations.ledger WHERE name=$1",
        [name]
      );
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(body);
        await client.query(
          "ALTER SCHEMA knowledge_migrations OWNER TO knowledge_migrate; ALTER TABLE knowledge_migrations.ledger OWNER TO knowledge_migrate"
        );
        await client.query(
          "INSERT INTO knowledge_migrations.ledger(name,checksum) VALUES ($1,$2)",
          [name, checksum]
        );
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    await client.query(
      "ALTER SCHEMA knowledge_migrations OWNER TO knowledge_migrate; ALTER TABLE knowledge_migrations.ledger OWNER TO knowledge_migrate"
    );
    const extensions = await verifyKnowledgeExtensions(client);
    return { applied, extensions };
  } finally {
    await client.query("SELECT pg_advisory_unlock(714203, 1)");
  }
}
