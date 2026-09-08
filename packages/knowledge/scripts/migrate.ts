import { resolve } from "node:path";
import pg from "pg";
import { applyKnowledgeMigrations } from "../src/migrations.server";
import { getDisposableLocalDatabaseUrl } from "../src/test/database";

const disposable = process.argv.includes("--disposable");
const connectionString = disposable
  ? getDisposableLocalDatabaseUrl()
  : process.env.KNOWLEDGE_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error("Dedicated migration database configuration required");
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
try {
  const client = await pool.connect();
  try {
    const applied = await applyKnowledgeMigrations(client, resolve(import.meta.dirname, "../migrations"));
    console.log(JSON.stringify({ applied, unchanged: applied.length === 0 }));
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
