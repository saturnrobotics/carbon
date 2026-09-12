import { randomUUID } from "node:crypto";
import {
  getPostgresConnectionPool,
  type KyselyDatabase
} from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join("") })
}));
vi.mock("@carbon/glossary", () => ({
  terms: {},
  getEntry: vi.fn(),
  lookupEntry: vi.fn(),
  hasEntry: vi.fn(),
  termSlug: vi.fn()
}));

const { createProcurementDraft, resolveProcurementDraft } = await import(
  "./purchasing.service"
);

// Same harness as the knowledge outbox/changes suites: skip without an isolated
// local database and refuse anything that is not local. The full Carbon schema
// is the point of this suite — the real sequence function, the real supplier
// interceptors, the real knowledge outbox trigger and real rollback.
const url = process.env.PROCUREMENT_DRAFT_TEST_DATABASE_URL;
let db: Kysely<KyselyDatabase>;

beforeAll(() => {
  if (!url) return;
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.port === "5432"
  ) {
    throw new Error(
      "Set PROCUREMENT_DRAFT_TEST_DATABASE_URL to an isolated local database"
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
  companyGroupId: string;
  userId: string;
  supplierId: string;
  locationId: string;
  itemReadableId: string;
  currentRevisionId: string;
  previousRevisionId: string;
};

const PAYLOAD_HASH = "a".repeat(64);
const IDEMPOTENCY_KEY = "procurement-command-1";
const PURCHASE_UOM = "BX";
const INVENTORY_UOM = "EA";

function context(fixture: Fixture, canCreatePurchasing = true) {
  return {
    companyId: fixture.companyId,
    companyGroupId: fixture.companyGroupId,
    actorId: fixture.userId,
    canCreatePurchasing
  };
}

function input(
  fixture: Pick<
    Fixture,
    "supplierId" | "locationId" | "itemReadableId" | "currentRevisionId"
  >,
  overrides: Record<string, unknown> = {},
  lineOverrides: Record<string, unknown> = {}
) {
  return {
    idempotencyKey: IDEMPOTENCY_KEY,
    payloadHash: PAYLOAD_HASH,
    supplierId: fixture.supplierId,
    receivingLocationId: fixture.locationId,
    orderDate: "2026-09-07",
    lines: [
      {
        itemId: fixture.itemReadableId,
        itemRevisionId: fixture.currentRevisionId,
        quantity: 2,
        purchaseUnitOfMeasureCode: PURCHASE_UOM,
        inventoryUnitOfMeasureCode: INVENTORY_UOM,
        conversionFactor: 10,
        supplierUnitPrice: 1.25,
        ...lineOverrides
      }
    ],
    ...overrides
  };
}

/**
 * A configured company is a prerequisite, not something a test may invent: the
 * units of measure, group currencies and document sequences a purchase order
 * needs are created by onboarding's own seeding, and a hand-built company would
 * prove the draft works against a schema no customer has. So the suite borrows
 * the local stack's seeded company and adds only its own user, supplier,
 * location, items and supplier part, removing each afterwards.
 */
async function seededCompany() {
  const rows = await sql<{ id: string; companyGroupId: string | null }>`
    select c.id, c."companyGroupId"
    from company c
    where (
        select count(*) from "unitOfMeasure" u
        where u."companyId" = c.id and u.code in (${INVENTORY_UOM}, ${PURCHASE_UOM})
      ) = 2
      and exists (
        select 1 from sequence s
        where s."companyId" = c.id and s."table" = 'purchaseOrder'
      )
    order by c.id
  `.execute(db);
  const company = rows.rows[0];
  if (rows.rows.length !== 1 || !company?.companyGroupId) {
    throw new Error(
      "This suite needs exactly one seeded company with units of measure and a purchaseOrder sequence"
    );
  }
  return { id: company.id, companyGroupId: company.companyGroupId };
}

async function fixture(run: (f: Fixture) => Promise<void>) {
  const company = await seededCompany();
  const userId = randomUUID();
  const created: Array<() => Promise<unknown>> = [];
  let supplierId = "";
  try {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.com` })
      .execute();
    const readableId = `PDF-${userId.slice(0, 8)}`;
    const supplier = await db
      .insertInto("supplier")
      .values({
        companyId: company.id,
        createdBy: userId,
        name: `Synthetic Supplier ${userId.slice(0, 8)}`,
        supplierStatus: "Active",
        currencyCode: "USD",
        taxPercent: 0.1
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    supplierId = supplier.id;
    created.push(() =>
      db.deleteFrom("supplier").where("id", "=", supplier.id).execute()
    );
    const location = await db
      .insertInto("location")
      .values({
        companyId: company.id,
        createdBy: userId,
        name: `Synthetic Receiving ${userId.slice(0, 8)}`,
        addressLine1: "1 Example Way",
        city: "Example",
        postalCode: "00000",
        timezone: "America/New_York"
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    created.push(() =>
      db.deleteFrom("location").where("id", "=", location.id).execute()
    );
    const revisions: string[] = [];
    for (const revision of ["A", "B"]) {
      const item = await db
        .insertInto("item")
        .values({
          companyId: company.id,
          createdBy: userId,
          readableId,
          revision,
          name: "Synthetic bracket",
          description: `Revision ${revision}`,
          type: "Part",
          itemTrackingType: "Inventory",
          unitOfMeasureCode: INVENTORY_UOM,
          revisionStatus: "Production"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      revisions.push(item.id);
      created.push(() =>
        db.deleteFrom("item").where("id", "=", item.id).execute()
      );
    }
    const [previousRevisionId, currentRevisionId] = revisions as [
      string,
      string
    ];
    await db
      .updateTable("itemReplenishment")
      .set({
        purchasingUnitOfMeasureCode: PURCHASE_UOM,
        conversionFactor: 10
      })
      .where("itemId", "=", currentRevisionId)
      .where("companyId", "=", company.id)
      .execute();
    await db
      .insertInto("supplierPart")
      .values({
        companyId: company.id,
        createdBy: userId,
        supplierId: supplier.id,
        itemId: currentRevisionId,
        active: true,
        supplierUnitOfMeasureCode: PURCHASE_UOM,
        conversionFactor: 10,
        unitPrice: 1.25
      })
      .execute();

    await run({
      companyId: company.id,
      companyGroupId: company.companyGroupId,
      userId,
      supplierId: supplier.id,
      locationId: location.id,
      itemReadableId: readableId,
      currentRevisionId,
      previousRevisionId
    });
  } finally {
    const orderIds = (await orders(userId)).map((order) => order.id);
    await db
      .deleteFrom("knowledgeCommandReceipt")
      .where("actorId", "=", userId)
      .execute();
    if (orderIds.length > 0) {
      await db
        .deleteFrom("knowledgeSourceOutbox")
        .where("entityType", "=", "purchaseOrder")
        .where("entityId", "in", orderIds)
        .execute();
      await db
        .deleteFrom("purchaseOrderLine")
        .where("purchaseOrderId", "in", orderIds)
        .execute();
      await db
        .deleteFrom("purchaseOrderPayment")
        .where("id", "in", orderIds)
        .execute();
      await db
        .deleteFrom("purchaseOrderDelivery")
        .where("id", "in", orderIds)
        .execute();
      await db
        .deleteFrom("purchaseOrder")
        .where("id", "in", orderIds)
        .execute();
    }
    await db
      .deleteFrom("supplierInteraction")
      .where("companyId", "=", company.id)
      .where("supplierId", "=", supplierId)
      .execute();
    await db
      .deleteFrom("changeOrder")
      .where("companyId", "=", company.id)
      .where("createdBy", "=", userId)
      .execute();
    await db
      .deleteFrom("supplierPart")
      .where("companyId", "=", company.id)
      .where("createdBy", "=", userId)
      .execute();
    for (const cleanup of created.reverse()) await cleanup();
    // Last: deleting the fixture's items announced tombstones of their own, and
    // every outbox row references the user that caused it.
    await db
      .deleteFrom("knowledgeSourceOutbox")
      .where("createdBy", "=", userId)
      .execute();
    await db.deleteFrom("user").where("id", "=", userId).execute();
  }
}

/** Only ever this fixture's own rows: the seeded company has data of its own.
 * DATE columns are read as text — node-postgres decodes them to a JS `Date`,
 * which is exactly the calendar-shifting value this repo never compares on. */
function orders(userId: string) {
  return db
    .selectFrom("purchaseOrder")
    .selectAll()
    .select(sql<string | null>`"orderDate"::text`.as("orderDay"))
    .where("createdBy", "=", userId)
    .execute();
}

async function counts(f: Fixture) {
  const orderIds = (await orders(f.userId)).map((order) => order.id);
  const scoped = async (
    table:
      | "purchaseOrderLine"
      | "purchaseOrderDelivery"
      | "purchaseOrderPayment",
    column: "purchaseOrderId" | "id"
  ) => {
    if (orderIds.length === 0) return 0;
    const rows = await sql<{ count: string }>`
      select count(*)::text as count from ${sql.table(table)}
      where ${sql.ref(column)} = any(${orderIds}::text[])
    `.execute(db);
    return Number(rows.rows[0]?.count ?? 0);
  };
  const receipts = await db
    .selectFrom("knowledgeCommandReceipt")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("actorId", "=", f.userId)
    .executeTakeFirstOrThrow();
  const interactions = await db
    .selectFrom("supplierInteraction")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("companyId", "=", f.companyId)
    .where("supplierId", "=", f.supplierId)
    .executeTakeFirstOrThrow();
  const outbox =
    orderIds.length === 0
      ? []
      : await db
          .selectFrom("knowledgeSourceOutbox")
          .select(["entityType", "entityId", "eventType"])
          .where("entityType", "=", "purchaseOrder")
          .where("entityId", "in", orderIds)
          .execute();
  return {
    orders: orderIds.length,
    lines: await scoped("purchaseOrderLine", "purchaseOrderId"),
    deliveries: await scoped("purchaseOrderDelivery", "id"),
    payments: await scoped("purchaseOrderPayment", "id"),
    interactions: Number(interactions.count),
    receipts: Number(receipts.count),
    outbox
  };
}

const NOTHING_WRITTEN = {
  orders: 0,
  lines: 0,
  deliveries: 0,
  payments: 0,
  interactions: 0,
  receipts: 0,
  outbox: []
};

describe.skipIf(!url)("createProcurementDraft", () => {
  it("writes one Draft PO with supplier defaults, line tax and a receipt", async () => {
    await fixture(async (f) => {
      const result = await createProcurementDraft(db, context(f), input(f));
      expect(result.replayed).toBe(false);

      const [order] = await orders(f.userId);
      expect(order).toMatchObject({
        id: result.purchaseOrderId,
        status: "Draft",
        purchaseOrderType: "Purchase",
        supplierId: f.supplierId,
        currencyCode: "USD",
        exchangeRate: 1,
        orderDay: "2026-09-07",
        createdBy: f.userId
      });
      expect(order?.purchaseOrderId).toMatch(/\d/);

      const delivery = await db
        .selectFrom("purchaseOrderDelivery")
        .select([
          "locationId",
          sql<string | null>`"receiptRequestedDate"::text`.as("requestedDay")
        ])
        .where("id", "=", order!.id)
        .executeTakeFirstOrThrow();
      expect(delivery.locationId).toBe(f.locationId);
      // The arrival date is receiving context; it never became the order date.
      expect(delivery.requestedDay).toBeNull();
      const payment = await db
        .selectFrom("purchaseOrderPayment")
        .selectAll()
        .where("id", "=", order!.id)
        .executeTakeFirstOrThrow();
      expect(payment.invoiceSupplierId).toBe(f.supplierId);

      const line = await db
        .selectFrom("purchaseOrderLine")
        .selectAll()
        .where("purchaseOrderId", "=", order!.id)
        .executeTakeFirstOrThrow();
      expect(line).toMatchObject({
        purchaseOrderLineType: "Part",
        itemId: f.currentRevisionId,
        purchaseQuantity: 2,
        purchaseUnitOfMeasureCode: PURCHASE_UOM,
        inventoryUnitOfMeasureCode: INVENTORY_UOM,
        conversionFactor: 10,
        supplierUnitPrice: 1.25,
        // 2 × 1.25 at the supplier's 10% tax, at the currency's own decimals.
        supplierTaxAmount: 0.25,
        taxPercent: 0.1,
        locationId: f.locationId,
        sortOrder: 1
      });

      const receipt = await db
        .selectFrom("knowledgeCommandReceipt")
        .selectAll()
        .where("actorId", "=", f.userId)
        .executeTakeFirstOrThrow();
      expect(receipt).toMatchObject({
        companyId: f.companyId,
        action: "carbon.procurement.draft",
        idempotencyKey: IDEMPOTENCY_KEY,
        payloadHash: PAYLOAD_HASH,
        purchaseOrderId: order!.id
      });
      // The payload contract the receipt was written under; BIGINT reaches the
      // node-postgres driver as a string, so it is compared numerically.
      expect(Number(receipt.version)).toBe(1);

      // The knowledge outbox event was written by the source trigger in the
      // SAME transaction; no post-commit notification is involved.
      expect(await counts(f)).toMatchObject({
        orders: 1,
        lines: 1,
        deliveries: 1,
        payments: 1,
        receipts: 1,
        outbox: [
          {
            entityType: "purchaseOrder",
            entityId: order!.id,
            eventType: "upsert"
          }
        ]
      });
    });
  });

  it("carries a requested arrival date onto the delivery, distinct from the order date", async () => {
    await fixture(async (f) => {
      await createProcurementDraft(
        db,
        context(f),
        input(f, { requestedArrivalDate: "2026-10-15" })
      );
      const [order] = await orders(f.userId);
      const delivery = await db
        .selectFrom("purchaseOrderDelivery")
        .select(
          sql<string | null>`"receiptRequestedDate"::text`.as("requestedDay")
        )
        .where("id", "=", order!.id)
        .executeTakeFirstOrThrow();
      expect(delivery.requestedDay).toBe("2026-10-15");
      expect(order?.orderDay).toBe("2026-09-07");
    });
  });

  it("defaults the order date to today on the company calendar", async () => {
    await fixture(async (f) => {
      const resolved = await resolveProcurementDraft(
        db,
        context(f),
        input(f, { orderDate: undefined })
      );
      const companyDay = await sql<{ today: string }>`
        select company_today(${f.companyId})::text as today
      `.execute(db);
      expect(resolved.orderDate).toBe(companyDay.rows[0]?.today);
    });
  });

  it.each([
    [
      "a supplier outside the company",
      { supplierId: "supplier-elsewhere" },
      {},
      /not an active supplier/
    ],
    [
      "an inactive supplier",
      { supplierId: "INACTIVE" },
      {},
      /not an active supplier/
    ],
    [
      "a location outside the company",
      { receivingLocationId: "location-elsewhere" },
      {},
      /Receiving location is not in this company/
    ],
    [
      "a superseded item revision",
      {},
      { itemRevisionId: "PREVIOUS" },
      /no longer the current released revision/
    ],
    [
      "a stale conversion factor",
      {},
      { conversionFactor: 5 },
      /proposal is stale/
    ],
    [
      "a stale purchase unit",
      {},
      { purchaseUnitOfMeasureCode: INVENTORY_UOM },
      /proposal is stale/
    ],
    [
      "a stale supplier price",
      {},
      { supplierUnitPrice: 0.99 },
      /proposal is stale/
    ],
    [
      "arrival before the order date",
      { requestedArrivalDate: "2026-09-01" },
      {},
      /cannot precede/
    ],
    ["a non-positive quantity", {}, { quantity: 0 }, /positive quantity/],
    [
      "an over-precise quantity",
      {},
      { quantity: 2.0001234 },
      /five decimal places/
    ]
  ])("refuses %s and writes nothing", async (_label, overrides, lineOverrides, message) => {
    await fixture(async (f) => {
      const resolved = { ...overrides } as Record<string, unknown>;
      if (resolved.supplierId === "INACTIVE") {
        await db
          .updateTable("supplier")
          .set({ supplierStatus: "Inactive" })
          .where("id", "=", f.supplierId)
          .execute();
        resolved.supplierId = f.supplierId;
      }
      const line = { ...lineOverrides } as Record<string, unknown>;
      if (line.itemRevisionId === "PREVIOUS") {
        line.itemRevisionId = f.previousRevisionId;
      }
      await expect(
        createProcurementDraft(db, context(f), input(f, resolved, line))
      ).rejects.toThrow(message);
      expect(await counts(f)).toEqual(NOTHING_WRITTEN);
    });
  });

  it("refuses an actor without current purchasing-create permission", async () => {
    await fixture(async (f) => {
      await expect(
        createProcurementDraft(db, context(f, false), input(f))
      ).rejects.toThrow(/Purchasing create permission is required/);
      expect(await counts(f)).toEqual(NOTHING_WRITTEN);
    });
  });

  it("reuses the unreleased-ECO guard before allocating anything", async () => {
    await fixture(async (f) => {
      const changeOrder = await db
        .insertInto("changeOrder")
        .values({
          companyId: f.companyId,
          createdBy: f.userId,
          changeOrderId: `ECO-${f.userId.slice(0, 8)}`,
          name: "Synthetic change order",
          openDate: "2026-09-01",
          status: "Draft"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("item")
        .set({ changeOrderId: changeOrder.id })
        .where("id", "=", f.currentRevisionId)
        .execute();

      await expect(
        createProcurementDraft(db, context(f), input(f))
      ).rejects.toThrow(/unreleased engineering change order/);
      expect(await counts(f)).toEqual(NOTHING_WRITTEN);

      // Releasing the change order makes the same command executable.
      await db
        .updateTable("changeOrder")
        .set({ status: "Done" })
        .where("id", "=", changeOrder.id)
        .execute();
      await expect(
        createProcurementDraft(db, context(f), input(f))
      ).resolves.toMatchObject({ replayed: false });
      await db
        .updateTable("item")
        .set({ changeOrderId: null })
        .where("id", "=", f.currentRevisionId)
        .execute();
    });
  });

  it("converges concurrent retries on one order and one receipt", async () => {
    await fixture(async (f) => {
      const [first, second] = await Promise.all([
        createProcurementDraft(db, context(f), input(f)),
        createProcurementDraft(db, context(f), input(f))
      ]);
      expect(
        new Set([first.purchaseOrderId, second.purchaseOrderId]).size
      ).toBe(1);
      expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
      expect(await counts(f)).toMatchObject({
        orders: 1,
        lines: 1,
        receipts: 1
      });
    });
  });

  it("replays a repeated command and refuses a changed payload under the same key", async () => {
    await fixture(async (f) => {
      const first = await createProcurementDraft(db, context(f), input(f));
      const replay = await createProcurementDraft(db, context(f), input(f));
      expect(replay).toEqual({
        purchaseOrderId: first.purchaseOrderId,
        replayed: true
      });

      await expect(
        createProcurementDraft(
          db,
          context(f),
          input(f, { payloadHash: "b".repeat(64) })
        )
      ).rejects.toThrow(/reused with a different payload/);
      expect(await counts(f)).toMatchObject({ orders: 1, receipts: 1 });
    });
  });

  it("rolls back header, lines, defaults, receipt and outbox on a fault", async () => {
    await fixture(async (f) => {
      // Fault injection at the LAST write of the transaction: by then the
      // order, its delivery, payment, lines and the outbox event all exist.
      await sql`
        create or replace function public.procurement_draft_fault() returns trigger
        language plpgsql as $$ begin raise exception 'injected receipt failure'; end $$
      `.execute(db);
      await sql`
        create trigger procurement_draft_fault
        before insert on public."knowledgeCommandReceipt"
        for each row execute function public.procurement_draft_fault()
      `.execute(db);
      try {
        await expect(
          createProcurementDraft(db, context(f), input(f))
        ).rejects.toThrow(/injected receipt failure/);
      } finally {
        await sql`
          drop trigger if exists procurement_draft_fault on public."knowledgeCommandReceipt"
        `.execute(db);
        await sql`
          drop function if exists public.procurement_draft_fault()
        `.execute(db);
      }

      expect(await counts(f)).toEqual(NOTHING_WRITTEN);
    });
  });

  it("refuses a command aimed at another company's supplier", async () => {
    await fixture(async (f) => {
      await expect(
        createProcurementDraft(
          db,
          { ...context(f), companyId: "company-elsewhere" },
          input(f)
        )
      ).rejects.toThrow(/not an active supplier/);
      expect(await counts(f)).toEqual(NOTHING_WRITTEN);
    });
  });
});
