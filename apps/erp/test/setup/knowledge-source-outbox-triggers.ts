import {
  getPostgresConnectionPool,
  type KyselyDatabase
} from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";

// The knowledge source-table triggers, for the suites that prove what
// knowledge_source_outbox_enqueue() records.
//
// 20260913060708_knowledge-source-outbox-triggers-off.sql detaches all four:
// the knowledge platform ships as a read-only pilot that does not consume the
// outbox, so the triggers are off rather than firing on four hot ERP write
// paths for nothing. The FUNCTION is kept, unchanged — re-enabling is four
// CREATE TRIGGER statements — and three suites exist to prove that function is
// right: knowledge.outbox.integration, knowledge.changes.integration and
// purchasing/procurement-draft.integration.
//
// Skipping them would leave the reviewed function with no coverage for the
// whole pilot, and a skip nobody notices is still a skip on the day the
// triggers come back. So the suites' own database gets the triggers for the
// length of the run instead, and the suites themselves are untouched: every
// assertion they make still has to pass.
//
// This is globalSetup rather than a per-suite beforeAll on purpose. The three
// suites run in parallel against ONE database, so a suite that attached and
// detached for itself would pull the triggers out from under another suite
// mid-run. globalSetup runs once in the main process before any worker starts
// and tears down once after the last one exits, which is the only place this
// can be done without that race.
//
// It attaches only what is MISSING and detaches only what it attached, so the
// day the operator re-enables the triggers by migration this becomes a no-op
// and the suites run against the shipped schema with no further edit.

/**
 * The four triggers exactly as `20260911205347_knowledge-source-outbox.sql`
 * created them. All four are the same shape — AFTER INSERT OR UPDATE OR
 * DELETE, FOR EACH ROW, no WHEN clause; the per-table gates live inside
 * `knowledge_source_outbox_enqueue()`, not in the trigger definitions.
 */
const OUTBOX_TRIGGERS = [
  { name: "knowledge_source_outbox_receipt_trigger", table: "receipt" },
  {
    name: "knowledge_source_outbox_receipt_line_trigger",
    table: "receiptLine"
  },
  { name: "knowledge_source_outbox_item_trigger", table: "item" },
  {
    name: "knowledge_source_outbox_purchase_order_trigger",
    table: "purchaseOrder"
  }
] as const;

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** The database the outbox suites were pointed at, or null if none was. */
function testDatabaseUrl(): string | null {
  const url =
    process.env.KNOWLEDGE_OUTBOX_TEST_DATABASE_URL ??
    process.env.PROCUREMENT_DRAFT_TEST_DATABASE_URL;
  if (!url) return null;
  // The same refusal the suites make: never touch a database that is not local.
  if (!LOCAL_HOSTNAMES.includes(new URL(url).hostname)) return null;
  return url;
}

export async function setup() {
  const url = testDatabaseUrl();
  if (!url) return;

  // getPostgresConnectionPool reads SUPABASE_DB_URL at construction, so name
  // the database the same way the suites themselves do. This runs in the main
  // process, and every worker gets its own value from vitest's `test.env`
  // before any suite reads it, so this assignment is not what the tests see.
  process.env.SUPABASE_DB_URL = url;
  const db = new Kysely<KyselyDatabase>({
    dialect: new PostgresDialect({ pool: getPostgresConnectionPool(1) })
  });

  const attached: { name: string; table: string }[] = [];
  try {
    for (const trigger of OUTBOX_TRIGGERS) {
      const present = await sql<{ present: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE NOT tgisinternal AND tgname = ${trigger.name}
        ) AS present
      `.execute(db);
      if (present.rows[0]?.present) continue;
      await sql`
        CREATE TRIGGER ${sql.id(trigger.name)}
          AFTER INSERT OR UPDATE OR DELETE ON ${sql.table(trigger.table)}
          FOR EACH ROW EXECUTE FUNCTION knowledge_source_outbox_enqueue()
      `.execute(db);
      attached.push(trigger);
    }
  } catch (error) {
    await detach(db, attached);
    throw error;
  }

  return () => detach(db, attached);
}

async function detach(
  db: Kysely<KyselyDatabase>,
  attached: { name: string; table: string }[]
) {
  try {
    for (const trigger of attached) {
      await sql`
        DROP TRIGGER IF EXISTS ${sql.id(trigger.name)}
          ON ${sql.table(trigger.table)}
      `.execute(db);
    }
  } finally {
    await db.destroy();
  }
}
