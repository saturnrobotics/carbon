/**
 * Checks that the demo datasets still apply against the current schema.
 *
 * Each dataset is applied to a throwaway company inside a transaction that is
 * always rolled back, so this writes NOTHING — it is safe to run against your
 * own development database. See `datasets/verify.ts` for the guarantee.
 *
 * Runs from the pre-commit hook when `packages/database/**` is touched; set
 * CARBON_SKIP_DATASET_CHECK=1 to skip it there.
 *
 * Usage:
 *   pnpm db:check:datasets                       # every dataset
 *   pnpm db:check:datasets -- --dataset motor    # one (repeatable)
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { format, parseArgs } from "node:util";
import type { PoolClient } from "pg";
import { getPostgresConnectionPool } from "./client.ts";
import { loadEnv } from "./datasets/cli.ts";
import { datasetKeys, getDataset } from "./datasets/index.ts";
import { resolveCheckUserId, verifyDataset } from "./datasets/verify.ts";

loadEnv();

function printUsage(keys: string[]) {
  process.stdout.write(`
Usage: pnpm db:check:datasets [-- --dataset <key>]

Applies each demo dataset to a throwaway company and rolls it back, so schema
drift surfaces without writing anything to your database.

Arguments:
  --dataset   Which dataset to check; repeat for several.
              Default: all (${keys.join(", ")})
`);
}

/** Environmental problems must not fail the check — a hook that fails for
 *  reasons you can't fix is a hook you learn to bypass. */
function skip(reason: string): never {
  process.stdout.write(`⚠ Dataset drift check skipped — ${reason}\n`);
  process.exit(0);
}

/**
 * A stale database fails the check for a column that DOES exist on `main`, so
 * without this the failure tells you to go fix the datasets when the real fix
 * is `pnpm db:migrate`. Returns 0 when the count can't be established — this
 * only ever adds a hint, so guessing wrong must never change the verdict.
 */
async function countPendingMigrations(client: PoolClient): Promise<number> {
  try {
    const dir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "supabase",
      "migrations"
    );
    const onDisk = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0] ?? "");

    const applied = await client.query<{ version: string }>(
      `SELECT version FROM supabase_migrations.schema_migrations`
    );
    const seen = new Set(applied.rows.map((r) => r.version));
    return onDisk.filter((v) => !seen.has(v)).length;
  } catch {
    return 0;
  }
}

async function main() {
  const keys = datasetKeys();
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      dataset: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false }
    },
    strict: true
  });

  if (values.help) {
    printUsage(keys);
    return;
  }

  const selected = values.dataset?.length ? values.dataset : keys;
  for (const key of selected) {
    if (!getDataset(key)) {
      process.stderr.write(
        `No such dataset: ${key}. Available: ${keys.join(", ")}\n`
      );
      process.exitCode = 1;
      return;
    }
  }

  // Match the existing unavailable-database policy before pool construction:
  // the shared factory requires a URL and cannot connect without one.
  if (!process.env.SUPABASE_DB_URL?.trim()) {
    skip("SUPABASE_DB_URL is not set (no local database configured)");
  }

  const pool = getPostgresConnectionPool(1);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    await pool.end().catch(() => {
      // Preserve the original connection failure if pool cleanup also fails.
    });
    skip(
      `no database connection (is your local stack up?)\n  ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  try {
    const userId = await resolveCheckUserId(client);
    if (!userId) skip("this database has no users yet (migrations applied?)");

    process.stdout.write(
      `Checking ${selected.length} dataset(s) against the schema...\n`
    );
    let failed = false;
    for (const key of selected) {
      const result = await verifyDataset(client, {
        dataset: getDataset(key)!,
        key,
        userId
      });
      const seconds = (result.durationMs / 1000).toFixed(1);
      if (result.ok) {
        process.stdout.write(`  ✓ ${key} (${seconds}s)\n`);
      } else {
        failed = true;
        process.stderr.write(`  ✗ ${key} (${seconds}s) — ${result.error}\n`);
      }
    }

    if (failed) {
      const pending = await countPendingMigrations(client);
      process.stderr.write(
        pending > 0
          ? `\nYour database is ${pending} migration(s) behind, so this may not be dataset drift at all — run pnpm db:migrate and check again before changing anything.\n`
          : `\nThe demo datasets no longer match the schema. Fix them in packages/database/src/datasets/ — onboarding's demo templates and pnpm db:seed:dev both run this code.\n`
      );
      process.stderr.write(
        `Re-run on its own with: pnpm db:check:datasets\nCommit anyway with:     CARBON_SKIP_DATASET_CHECK=1 git commit ...\n`
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`\nError checking datasets:\n${format(error)}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${format(err instanceof Error ? err.message : err)}\n`);
  process.exitCode = 1;
});
