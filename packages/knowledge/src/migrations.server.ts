import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolClient } from "pg";

/** One connection and advisory lock cover checksum checks and every applied file. */
export async function applyKnowledgeMigrations(
  client: PoolClient,
  directory: string
) {
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
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(714203, 1)");
  }
}
