import { randomUUID } from "node:crypto";
import {
  getPostgresConnectionPool,
  type KyselyDatabase
} from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acknowledgePortalEvent,
  claimPendingPortalEvents
} from "./portal.events.server";

// Like the sibling integration suites (invoice intake backfill, items
// creation): skip when no local database is configured, refuse anything that
// is not local. The pool deliberately does NOT set app.sync_in_progress —
// that flag is exactly what silences the triggers under test.
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

class Rollback extends Error {}

type Fixture = {
  companyId: string;
  userId: string;
  itemId: string;
  receiptId: string;
  receiptLineId: string;
};

/** A company with one item, one draft receipt and one line, removed afterwards. */
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
      .values({ name: "Portal Outbox Fixture", baseCurrencyCode: "USD" })
      .returning("id")
      .executeTakeFirstOrThrow();
    companyId = company.id;
    const item = await db
      .insertInto("item")
      .values({
        companyId,
        createdBy: userId,
        readableId: `KSO-${userId.slice(0, 8)}`,
        name: "Synthetic bracket",
        type: "Part",
        itemTrackingType: "Inventory"
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
    // Creating the item announced its identity; the draft receipt and its
    // line announced nothing. Each scenario then starts from a clean outbox.
    const setup = await db
      .selectFrom("portalSourceOutbox")
      .select(["entityType", "entityId", "eventType"])
      .where("companyId", "=", companyId)
      .execute();
    expect(setup).toEqual([
      { entityType: "item", entityId: item.id, eventType: "upsert" }
    ]);
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
      for (const table of [
        "receiptLine",
        "receipt",
        "purchaseOrder",
        "supplierInteraction",
        "supplier",
        "item"
      ] as const) {
        await db.deleteFrom(table).where("companyId", "=", companyId).execute();
      }
      // The outbox rows (including the tombstones those deletes just wrote)
      // go with the company.
      await db.deleteFrom("company").where("id", "=", companyId).execute();
    }
    await db.deleteFrom("user").where("id", "=", userId).execute();
  }
}

const outboxRows = (companyId: string) =>
  db
    .selectFrom("portalSourceOutbox")
    .select([
      "id",
      "entityType",
      "entityId",
      "sourceVersion",
      "eventType",
      "payload",
      "attempts",
      "leaseOwner",
      sql<string | null>`"deliveredAt"::text`.as("deliveredAt")
    ])
    .where("companyId", "=", companyId)
    .orderBy("createdAt")
    .orderBy("id")
    .execute();

const postReceipt = (
  trx: Kysely<KyselyDatabase>,
  f: Fixture,
  updatedAt = "2026-09-01T10:20:30.123456Z"
) =>
  trx
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

describe.skipIf(!url)("portal source outbox", () => {
  it("records a posted receipt only when its transaction commits", async () =>
    fixture(async (f) => {
      await expect(
        db.transaction().execute(async (trx) => {
          await postReceipt(trx, f);
          const inside = await trx
            .selectFrom("portalSourceOutbox")
            .select("id")
            .where("companyId", "=", f.companyId)
            .execute();
          expect(inside).toHaveLength(1);
          throw new Rollback();
        })
      ).rejects.toBeInstanceOf(Rollback);
      expect(await outboxRows(f.companyId)).toEqual([]);

      await postReceipt(db, f);
      const rows = await outboxRows(f.companyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entityType: "receipt",
        entityId: f.receiptId,
        eventType: "upsert",
        // The version a reader sees on the entity itself: the bumped
        // updatedAt, in UTC with full microsecond precision.
        sourceVersion: "2026-09-01T10:20:30.123456Z",
        payload: {},
        attempts: 0,
        leaseOwner: null,
        deliveredAt: null
      });
    }));

  it("dedupes a replayed write and a duplicate event identity", async () =>
    fixture(async (f) => {
      await postReceipt(db, f);
      // Replaying the identical posting write changes nothing a reader can
      // see, so it is not a second event.
      await postReceipt(db, f);
      expect(await outboxRows(f.companyId)).toHaveLength(1);

      // Recording the same identity again (a duplicate enqueue) is one event.
      const [first] = await outboxRows(f.companyId);
      const duplicate = () =>
        db
          .insertInto("portalSourceOutbox")
          .values({
            companyId: f.companyId,
            entityType: "receipt",
            entityId: f.receiptId,
            sourceVersion: first!.sourceVersion,
            eventType: "upsert",
            createdBy: f.userId
          })
          .onConflict((oc) =>
            oc
              .columns([
                "companyId",
                "source",
                "entityType",
                "entityId",
                "sourceVersion",
                "eventType"
              ])
              .doNothing()
          )
          .execute();
      await duplicate();
      expect(await outboxRows(f.companyId)).toHaveLength(1);

      // A change that does not bump updatedAt is still a distinct event,
      // versioned by its transaction rather than merged into the last one.
      await db
        .updateTable("receipt")
        .set({ postingDate: "2026-09-02" })
        .where("id", "=", f.receiptId)
        .where("companyId", "=", f.companyId)
        .execute();
      const rows = await outboxRows(f.companyId);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.sourceVersion).toMatch(/^xid:\d+$/);
      expect(rows[1]!.sourceVersion).not.toBe(rows[0]!.sourceVersion);
    }));

  it("leases claims and refuses acknowledgement from a lost lease", async () =>
    fixture(async (f) => {
      await postReceipt(db, f);
      const claimedByA = await claimPendingPortalEvents(db, f.companyId, 10, {
        workerId: "worker-a"
      });
      expect(claimedByA).toHaveLength(1);
      expect(claimedByA[0]).toMatchObject({
        source: "carbon",
        entityType: "receipt",
        entityId: f.receiptId,
        eventType: "upsert",
        attempts: 1
      });
      const eventId = claimedByA[0]!.id;

      // Leased rows are invisible to a second claimant until the lease lapses.
      expect(
        await claimPendingPortalEvents(db, f.companyId, 10, {
          workerId: "worker-b"
        })
      ).toEqual([]);
      await expect(
        acknowledgePortalEvent(db, {
          companyId: f.companyId,
          eventId,
          workerId: "worker-b"
        })
      ).rejects.toThrow("lease was lost");

      // Worker A stalls past its lease; worker B takes the event over.
      await db
        .updateTable("portalSourceOutbox")
        .set({ leaseExpiresAt: sql`now() - interval '1 minute'` })
        .where("companyId", "=", f.companyId)
        .where("id", "=", eventId)
        .execute();
      const claimedByB = await claimPendingPortalEvents(db, f.companyId, 10, {
        workerId: "worker-b"
      });
      expect(claimedByB.map((event) => event.id)).toEqual([eventId]);
      expect(claimedByB[0]!.attempts).toBe(2);

      // A's lease is gone: it cannot acknowledge work B now owns.
      await expect(
        acknowledgePortalEvent(db, {
          companyId: f.companyId,
          eventId,
          workerId: "worker-a"
        })
      ).rejects.toThrow("lease was lost");
      await acknowledgePortalEvent(db, {
        companyId: f.companyId,
        eventId,
        workerId: "worker-b"
      });
      const [delivered] = await outboxRows(f.companyId);
      expect(delivered).toMatchObject({ leaseOwner: null });
      expect(delivered!.deliveredAt).not.toBeNull();
      // Delivered is final for that identity: nothing left to claim, and a
      // second acknowledgement is not a silent success.
      expect(
        await claimPendingPortalEvents(db, f.companyId, 10, {
          workerId: "worker-b"
        })
      ).toEqual([]);
      await expect(
        acknowledgePortalEvent(db, {
          companyId: f.companyId,
          eventId,
          workerId: "worker-b"
        })
      ).rejects.toThrow("lease was lost");
    }));

  it("claims tombstones before upserts and announces lines only through a posted receipt", async () =>
    fixture(async (f) => {
      // A line edit on a draft receipt is invisible to readers.
      await db
        .updateTable("receiptLine")
        .set({ receivedQuantity: 1, updatedAt: "2026-09-01T09:00:00Z" })
        .where("id", "=", f.receiptLineId)
        .where("companyId", "=", f.companyId)
        .execute();
      expect(await outboxRows(f.companyId)).toEqual([]);

      await postReceipt(db, f);
      await db
        .updateTable("receiptLine")
        .set({ receivedQuantity: 2, updatedAt: "2026-09-01T11:00:00Z" })
        .where("id", "=", f.receiptLineId)
        .where("companyId", "=", f.companyId)
        .execute();
      // Identity fields announce the item; an unrelated field does not.
      await db
        .updateTable("item")
        .set({ assignee: f.userId })
        .where("id", "=", f.itemId)
        .execute();
      await db
        .updateTable("item")
        .set({ revision: "B", updatedAt: "2026-09-01T12:00:00Z" })
        .where("id", "=", f.itemId)
        .execute();
      // Voiding a posted receipt is a tombstone, and it is delivered first.
      await db
        .updateTable("receipt")
        .set({ status: "Voided", updatedAt: "2026-09-01T13:00:00Z" })
        .where("id", "=", f.receiptId)
        .where("companyId", "=", f.companyId)
        .execute();

      const rows = await outboxRows(f.companyId);
      expect(
        rows.map((row) => [row.entityType, row.eventType, row.payload])
      ).toEqual([
        ["receipt", "upsert", {}],
        ["receiptLine", "upsert", { receiptId: f.receiptId }],
        ["item", "upsert", {}],
        ["receipt", "delete", {}]
      ]);

      const claimed = await claimPendingPortalEvents(db, f.companyId, 2, {
        workerId: "worker-a"
      });
      expect(claimed.map((event) => event.eventType)).toEqual([
        "delete",
        "upsert"
      ]);
    }));

  // Deleting a company (settings.service.ts deleteSubsidiary) CASCADEs to all
  // four source tables, so the trigger runs for each child row after the
  // "company" row it references is already gone. Enqueueing there aborts the
  // whole delete on portalSourceOutbox_companyId_fkey. This is the ONLY
  // state in which the company can be absent — companyId is NOT NULL with its
  // own FK on every source table — and the event it would describe names a
  // company, an entity and an outbox row the same statement is deleting.
  it("lets a company delete cascade instead of recording an undeliverable event", async () =>
    fixture(async (f) => {
      // Qualifying, unclaimed rows are present on all four source tables when
      // the delete starts: an item, a posted receipt, its line, and an order.
      await postReceipt(db, f);
      await db
        .updateTable("receiptLine")
        .set({ receivedQuantity: 2, updatedAt: "2026-09-01T11:00:00Z" })
        .where("id", "=", f.receiptLineId)
        .where("companyId", "=", f.companyId)
        .execute();
      const supplier = await db
        .insertInto("supplier")
        .values({ name: "Teardown Supplier", companyId: f.companyId })
        .returning("id")
        .executeTakeFirstOrThrow();
      const interaction = await db
        .insertInto("supplierInteraction")
        .values({ companyId: f.companyId, supplierId: supplier.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("purchaseOrder")
        .values({
          companyId: f.companyId,
          createdBy: f.userId,
          purchaseOrderId: `PO-${f.userId.slice(0, 8)}`,
          supplierId: supplier.id,
          supplierInteractionId: interaction.id
        })
        .execute();
      expect(
        (await outboxRows(f.companyId)).map((row) => row.entityType)
      ).toEqual(["receipt", "receiptLine", "purchaseOrder"]);

      // The bare production shape: no pre-deletion of children, just the row.
      await db.deleteFrom("company").where("id", "=", f.companyId).execute();

      expect(await outboxRows(f.companyId)).toEqual([]);
      const survivors = await db
        .selectFrom("portalSourceOutbox")
        .select("id")
        .where("companyId", "=", f.companyId)
        .execute();
      expect(survivors).toEqual([]);
    }));

  // The other side of that guard: a company the trigger has never seen
  // COMMITTED is still a live company, and its events are real. An
  // existence check that could not see an uncommitted insert would silently
  // drop every event of a company created and seeded in one transaction.
  it("records events for a company created in the same open transaction", async () => {
    const userId = randomUUID();
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.com` })
      .execute();
    try {
      await expect(
        db.transaction().execute(async (trx) => {
          const company = await trx
            .insertInto("company")
            .values({ name: "Uncommitted Company", baseCurrencyCode: "USD" })
            .returning("id")
            .executeTakeFirstOrThrow();
          const item = await trx
            .insertInto("item")
            .values({
              companyId: company.id,
              createdBy: userId,
              readableId: `KSO-NEW-${userId.slice(0, 8)}`,
              name: "Synthetic bracket",
              type: "Part",
              itemTrackingType: "Inventory"
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          const inside = await trx
            .selectFrom("portalSourceOutbox")
            .select(["entityType", "entityId", "eventType"])
            .where("companyId", "=", company.id)
            .execute();
          expect(inside).toEqual([
            { entityType: "item", entityId: item.id, eventType: "upsert" }
          ]);
          throw new Rollback();
        })
      ).rejects.toBeInstanceOf(Rollback);
    } finally {
      await db.deleteFrom("user").where("id", "=", userId).execute();
    }
  });
});
