import { randomUUID } from "node:crypto";
import {
  getPostgresConnectionPool,
  type KyselyDatabase
} from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acknowledgePortalSourceChanges,
  claimPortalSourceChanges,
  getPortalSourceEntityProjections,
  listPortalSourceEntityVersions
} from "./portal.changes.server";

// Same harness as the outbox suite: skip without an isolated local database,
// refuse anything that is not local, never set app.sync_in_progress.
const url = process.env.PORTAL_OUTBOX_TEST_DATABASE_URL;
let db: Kysely<KyselyDatabase>;

beforeAll(() => {
  if (!url) return;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error(
      "Set PORTAL_OUTBOX_TEST_DATABASE_URL to an isolated local database"
    );
  }
  process.env.SUPABASE_DB_URL = url;
  db = new Kysely<KyselyDatabase>({
    dialect: new PostgresDialect({ pool: getPostgresConnectionPool(4) })
  });
});
afterAll(async () => {
  await db?.destroy();
});

type Fixture = {
  companyId: string;
  userId: string;
  itemId: string;
  receiptId: string;
  receiptLineId: string;
};

async function fixture(run: (f: Fixture) => Promise<void>) {
  const userId = randomUUID();
  let companyId: string | undefined;
  try {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.com` })
      .execute();
    const company = await db
      .insertInto("company")
      .values({ name: "Portal Changes Fixture", baseCurrencyCode: "USD" })
      .returning("id")
      .executeTakeFirstOrThrow();
    companyId = company.id;
    const item = await db
      .insertInto("item")
      .values({
        companyId,
        createdBy: userId,
        readableId: `KSC-${userId.slice(0, 8)}`,
        name: "Synthetic stepper motor",
        type: "Part",
        itemTrackingType: "Inventory",
        // The projection must never carry this; it is a cost, not identity.
        description: "NEMA 34 frame, 6 N·m"
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const receipt = await db
      .insertInto("receipt")
      .values({
        companyId,
        createdBy: userId,
        receiptId: `RCV-${userId.slice(0, 8)}`
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const line = await db
      .insertInto("receiptLine")
      .values({
        companyId,
        createdBy: userId,
        receiptId: receipt.id,
        itemId: item.id,
        orderQuantity: 1,
        unitOfMeasure: "EA",
        unitPrice: 0
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .deleteFrom("portalSourceOutbox")
      .where("companyId", "=", companyId)
      .execute();
    await run({
      companyId,
      userId,
      itemId: item.id,
      receiptId: receipt.id,
      receiptLineId: line.id
    });
  } finally {
    if (companyId) {
      for (const table of ["receiptLine", "receipt", "item"] as const) {
        await db.deleteFrom(table).where("companyId", "=", companyId).execute();
      }
      await db.deleteFrom("company").where("id", "=", companyId).execute();
    }
    await db.deleteFrom("user").where("id", "=", userId).execute();
  }
}

const postReceipt = (f: Fixture, updatedAt = "2026-09-01T10:20:30.123456Z") =>
  db
    .updateTable("receipt")
    .set({
      status: "Posted",
      postingDate: "2026-09-01",
      updatedAt,
      updatedBy: f.userId
    })
    .where("id", "=", f.receiptId)
    .where("companyId", "=", f.companyId)
    .execute();

describe.skipIf(!url)("portal source changes feed", () => {
  it("claims events with the projection Carbon shows now, lands a line on its receipt, and hides unposted rows", async () =>
    fixture(async (f) => {
      await postReceipt(f);
      // Posting announced the receipt; touch the line so a line event exists.
      await db
        .updateTable("receiptLine")
        .set({ orderQuantity: 2, updatedAt: "2026-09-01T10:21:00.000000Z" })
        .where("id", "=", f.receiptLineId)
        .where("companyId", "=", f.companyId)
        .execute();
      const page = await claimPortalSourceChanges(db, {
        companyId: f.companyId,
        workerId: "worker-a",
        limit: 100
      });
      expect(page.status).toBe("complete");
      expect(page.leaseExpiresAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/
      );
      const receiptEvent = page.items.find((c) => c.entityType === "receipt");
      const lineEvent = page.items.find((c) => c.entityType === "receiptLine");
      expect(receiptEvent?.entity).toMatchObject({
        id: f.receiptId,
        type: "receipt",
        revision: "2026-09-01T10:20:30.123456Z",
        fields: { status: "Posted", postingDate: "2026-09-01" }
      });
      expect(lineEvent).toMatchObject({
        target: { entityType: "receipt", entityId: f.receiptId },
        entity: { id: f.receiptId, type: "receipt" }
      });
      expect(JSON.stringify(page)).not.toMatch(/unitPrice|cost/i);

      // A second worker cannot claim the leased rows; the first can acknowledge
      // them in one statement, after which nothing is pending.
      const other = await claimPortalSourceChanges(db, {
        companyId: f.companyId,
        workerId: "worker-b",
        limit: 100
      });
      expect(other.items).toEqual([]);
      const ack = await acknowledgePortalSourceChanges(db, {
        companyId: f.companyId,
        workerId: "worker-b",
        eventIds: page.items.map((c) => c.id)
      });
      expect(ack.acknowledged).toEqual([]);
      const mine = await acknowledgePortalSourceChanges(db, {
        companyId: f.companyId,
        workerId: "worker-a",
        eventIds: page.items.map((c) => c.id)
      });
      expect(new Set(mine.acknowledged)).toEqual(
        new Set(page.items.map((c) => c.id))
      );

      // Unposting the receipt is a tombstone: the upsert carries no entity.
      await db
        .updateTable("receipt")
        .set({ status: "Draft", updatedAt: "2026-09-01T10:30:00.000000Z" })
        .where("id", "=", f.receiptId)
        .where("companyId", "=", f.companyId)
        .execute();
      const gone = await claimPortalSourceChanges(db, {
        companyId: f.companyId,
        workerId: "worker-a",
        limit: 100
      });
      expect(gone.items).toHaveLength(1);
      expect(gone.items[0]).toMatchObject({
        entityType: "receipt",
        eventType: "delete",
        entity: null
      });
    }));

  it("lists versions in byte order with the trigger's version format and projects a batch", async () =>
    fixture(async (f) => {
      await postReceipt(f);
      const versions = await listPortalSourceEntityVersions(db, {
        companyId: f.companyId,
        entityType: "receipt",
        limit: 100
      });
      expect(versions.items).toEqual([
        { entityId: f.receiptId, sourceVersion: "2026-09-01T10:20:30.123456Z" }
      ]);
      expect(versions.status).toBe("complete");
      const items = await listPortalSourceEntityVersions(db, {
        companyId: f.companyId,
        entityType: "item",
        cursor: f.itemId,
        limit: 100
      });
      // Keyset after the only row: nothing follows.
      expect(items.items).toEqual([]);
      const projections = await getPortalSourceEntityProjections(db, {
        companyId: f.companyId,
        entityType: "item",
        entityIds: [f.itemId, "item_missing"]
      });
      expect(projections.items).toHaveLength(1);
      expect(projections.items[0]).toMatchObject({
        id: f.itemId,
        type: "part",
        title: "Synthetic stepper motor",
        fields: { readableId: `KSC-${f.userId.slice(0, 8)}` }
      });
      // Another company's rows are invisible even when their ids are named.
      const foreign = await sql<{ id: string }>`
        SELECT id FROM "item" WHERE "companyId" <> ${f.companyId} LIMIT 1
      `.execute(db);
      if (foreign.rows[0]) {
        const leak = await getPortalSourceEntityProjections(db, {
          companyId: f.companyId,
          entityType: "item",
          entityIds: [foreign.rows[0].id]
        });
        expect(leak.items).toEqual([]);
      }
    }));
});
