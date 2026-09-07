import { randomUUID } from "node:crypto";
import {
  getPostgresConnectionPool,
  type KyselyDatabase
} from "@carbon/database/client";
import { approveMercuryImport } from "@carbon/database/mercury";
import { emptyInvoiceExtraction } from "@carbon/jobs";
import { Kysely, PostgresDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("~/modules/settings", () => ({ getCompanySettings: vi.fn() }));
vi.mock("@carbon/glossary", () => ({
  terms: {},
  getEntry: vi.fn(),
  lookupEntry: vi.fn(),
  hasEntry: vi.fn(),
  termSlug: vi.fn()
}));
const {
  approveInvoiceIntake,
  getInvoiceIntakeReview,
  getInvoiceIntakeInbox,
  saveInvoiceIntakeReview,
  setInvoiceIntakeStatus,
  updateInvoiceRecognitionRule,
  validateHydratedInvoiceIntake
} = await import("./invoicing.server");
const { invoiceIntakeReviewValidator } = await import("./invoicing.models");
const { createReviewedItem } = await import("../items/items.server");

import type { InvoiceIntakeReview } from "./invoicing.models";

const url = process.env.INVOICE_INTAKE_TEST_DATABASE_URL;
let db: Kysely<KyselyDatabase>;
beforeAll(() => {
  if (
    !url ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
  )
    throw new Error(
      "An explicit localhost invoice intake test database is required"
    );
  process.env.SUPABASE_DB_URL = url;
  db = new Kysely<KyselyDatabase>({
    dialect: new PostgresDialect({ pool: getPostgresConnectionPool(4) })
  });
});
afterAll(async () => {
  if (db) await db.destroy();
});
type Fixture = {
  actor: { companyId: string; userId: string };
  supplierId: string;
  itemId: string;
  locationId: string;
  groupId: string;
};
async function fixture(run: (value: Fixture) => Promise<void>) {
  const userId = randomUUID();
  let companyId: string | undefined;
  let groupId: string | undefined;
  try {
    const seeded = await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("user")
        .values({ id: userId, email: userId + "@example.com", active: true })
        .execute();
      const group = await trx
        .insertInto("companyGroup")
        .values({ name: "Invoice Integration Fixture" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const company = await trx
        .insertInto("company")
        .values({
          name: "Invoice Integration Fixture",
          companyGroupId: group.id,
          baseCurrencyCode: "USD",
          timezone: "UTC"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const actor = { companyId: company.id, userId };
      await trx
        .insertInto("group")
        .values({
          id:
            "00000000-0000-" +
            company.id.slice(0, 4) +
            "-" +
            company.id.slice(4, 8) +
            "-" +
            company.id.slice(8, 20),
          name: "Employees",
          companyId: company.id
        })
        .execute();
      const type = await trx
        .insertInto("employeeType")
        .values({ name: "Reviewer", companyId: company.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("employeeTypePermission")
        .values(
          (
            [
              "Invoicing",
              "Purchasing",
              "Parts",
              "Accounting",
              "Settings"
            ] as const
          ).map((module) => ({
            employeeTypeId: type.id,
            module,
            view: [company.id],
            create: [company.id],
            update: [company.id]
          }))
        )
        .onConflict((oc) =>
          oc.columns(["employeeTypeId", "module"]).doUpdateSet({
            view: [company.id],
            create: [company.id],
            update: [company.id]
          })
        )
        .execute();
      await trx
        .insertInto("userToCompany")
        .values({ ...actor, role: "employee" })
        .execute();
      await trx
        .insertInto("employee")
        .values({
          id: userId,
          companyId: company.id,
          employeeTypeId: type.id,
          active: true
        })
        .execute();
      const permissions = Object.fromEntries(
        [
          "invoicing_view",
          "invoicing_create",
          "invoicing_update",
          "purchasing_create",
          "purchasing_update",
          "parts_create",
          "parts_update",
          "accounting_view",
          "settings_update"
        ].map((key) => [key, [company.id]])
      );
      await trx
        .insertInto("userPermission")
        .values({ id: userId, permissions })
        .onConflict((oc) => oc.column("id").doUpdateSet({ permissions }))
        .execute();
      await trx
        .insertInto("sequence")
        .values(
          ["supplier", "purchaseInvoice"].map((table) => ({
            table,
            name: table,
            prefix: table === "supplier" ? "SUP-" : "PI-",
            next: 0,
            step: 1,
            size: 4,
            companyId: company.id
          }))
        )
        .execute();
      await trx
        .insertInto("currency")
        .values({
          code: "USD",
          companyGroupId: group.id,
          createdBy: userId,
          decimalPlaces: 2
        })
        .execute();
      await trx
        .insertInto("unitOfMeasure")
        .values({
          code: "EA",
          name: "Each",
          companyId: company.id,
          createdBy: userId
        })
        .execute();
      const location = await trx
        .insertInto("location")
        .values({
          name: "Synthetic Warehouse",
          addressLine1: "1 Test Road",
          city: "Test",
          postalCode: "00000",
          timezone: "UTC",
          companyId: company.id,
          createdBy: userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const supplier = await trx
        .insertInto("supplier")
        .values({
          name: "Synthetic Supplier",
          companyId: company.id,
          createdBy: userId,
          supplierStatus: "Active"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const item = await createReviewedItem(trx, actor, {
        type: "Consumable",
        data: {
          id: "TEST-BOLT",
          name: "Synthetic Bolt",
          replenishmentSystem: "Buy",
          defaultMethodType: "Pull from Inventory",
          itemTrackingType: "Inventory",
          unitOfMeasureCode: "EA",
          unitCost: 5
        }
      });
      return {
        actor,
        supplierId: supplier.id,
        itemId: item.id,
        locationId: location.id,
        groupId: group.id
      };
    });
    companyId = seeded.actor.companyId;
    groupId = seeded.groupId;
    await run(seeded);
  } finally {
    if (companyId)
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("invoiceIntake")
          .set({ activeExtractionId: null })
          .where("companyId", "=", companyId!)
          .execute();
        await trx
          .deleteFrom("documentExtraction")
          .where("companyId", "=", companyId!)
          .execute();
        await trx
          .deleteFrom("invoiceRecognitionRule")
          .where("companyId", "=", companyId!)
          .execute();
        await trx
          .deleteFrom("invoiceIntake")
          .where("companyId", "=", companyId!)
          .execute();
        await trx
          .deleteFrom("mercuryTransactionImport")
          .where("companyId", "=", companyId!)
          .execute();
        await trx.deleteFrom("company").where("id", "=", companyId!).execute();
        if (groupId)
          await trx
            .deleteFrom("companyGroup")
            .where("id", "=", groupId)
            .execute();
        await trx.deleteFrom("user").where("id", "=", userId).execute();
      });
  }
}
function review(f: Fixture): InvoiceIntakeReview {
  return invoiceIntakeReviewValidator.parse({
    documentKind: "invoice",
    supplierId: f.supplierId,
    locationId: f.locationId,
    header: {
      invoiceNumber: "EXAMPLE-1",
      issueDate: "2026-02-28",
      currencyCode: "USD",
      subtotal: "10",
      total: "10",
      chargesConfirmed: true,
      sourceSupplierName: "Synthetic Supplier"
    },
    lines: [
      {
        lineKey: "one",
        sortOrder: 0,
        description: "Synthetic Bolt",
        quantity: "2",
        supplierUnitPrice: "5",
        itemId: f.itemId,
        lineType: "Consumable",
        purchaseUnit: "EA",
        stockUnit: "EA",
        conversionFactor: "1",
        locationId: f.locationId
      }
    ]
  });
}
async function intake(f: Fixture, value = review(f)) {
  const row = await db
    .insertInto("invoiceIntake")
    .values({
      companyId: f.actor.companyId,
      createdBy: f.actor.userId,
      status: "NeedsReview"
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await attach(f, row.id);
  const saved = await saveInvoiceIntakeReview(db, f.actor, {
    id: row.id,
    expectedRevision: 0,
    review: value
  });
  return { ...row, ...saved };
}
async function counts(f: Fixture) {
  return (
    await sql<{ count: string }>`SELECT (
    (SELECT count(*) FROM "itemLedger" WHERE "companyId"=${f.actor.companyId})+
    (SELECT count(*) FROM "costLedger" WHERE "companyId"=${f.actor.companyId})+
    (SELECT count(*) FROM receipt WHERE "companyId"=${f.actor.companyId})+
    (SELECT count(*) FROM journal WHERE "companyId"=${f.actor.companyId})+
    (SELECT count(*) FROM "journalLine" WHERE "companyId"=${f.actor.companyId})+
    (SELECT count(*) FROM payment WHERE "companyId"=${f.actor.companyId})+
    (SELECT count(*) FROM "supplierLedger" WHERE "companyId"=${f.actor.companyId})
  )::text count`.execute(db)
  ).rows[0].count;
}
async function payment(f: Fixture, amount = 4) {
  return db
    .insertInto("mercuryTransactionImport")
    .values({
      companyId: f.actor.companyId,
      createdBy: f.actor.userId,
      amount,
      currencyCode: "USD",
      mercuryAccountId: "synthetic-account",
      mercuryTransactionId: randomUUID(),
      mercuryRecipientId: "synthetic-recipient",
      remoteStatus: "sent",
      transactionDate: "2026-02-28"
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
async function attach(f: Fixture, id: string, importId?: string) {
  const sourceKey = randomUUID();
  await db
    .insertInto("invoiceIntakeSource")
    .values({
      companyId: f.actor.companyId,
      intakeId: id,
      createdBy: f.actor.userId,
      kind: importId ? "mercury" : "upload",
      sourceKey,
      mercuryImportId: importId,
      storageBucket: "private",
      storagePath: f.actor.companyId + "/invoice-intake/" + id + "/source.pdf",
      sha256: "a".repeat(64),
      mediaType: "application/pdf",
      byteSize: 120,
      fileName: "fixture.pdf"
    })
    .execute();
}

describe("Atomic invoice intake approval", () => {
  it("saves an incomplete invoice reference as NeedsReview without creating masters", async () => {
    await fixture(async (f) => {
      const value = review(f);
      value.header.invoiceNumber = null;
      value.supplierId = null;
      value.newSupplier = {
        supplier: { name: "Incomplete supplier proposal" }
      };
      const result = await intake(f, value);
      expect(result.status).toBe("NeedsReview");
      const suppliers = await db
        .selectFrom("supplier")
        .select("id")
        .where("companyId", "=", f.actor.companyId)
        .execute();
      const invoices = await db
        .selectFrom("purchaseInvoice")
        .select("id")
        .where("companyId", "=", f.actor.companyId)
        .execute();
      expect(suppliers).toHaveLength(1);
      expect(invoices).toHaveLength(0);
    });
  });
  it("creates one typed native Draft under concurrent/repeated approval and leaves copying durable without posting", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      await attach(f, row.id);
      const input = {
        intakeId: row.id,
        expectedRevision: row.revision,
        approvalKey: randomUUID()
      };
      const results = await Promise.all([
        approveInvoiceIntake(db, f.actor, input),
        approveInvoiceIntake(db, f.actor, input)
      ]);
      expect(new Set(results.map((result) => result.invoiceId)).size).toBe(1);
      expect(results.filter((result) => result.repeated)).toHaveLength(1);
      const invoices = await db
        .selectFrom("purchaseInvoice")
        .selectAll()
        .where("companyId", "=", f.actor.companyId)
        .execute();
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({
        invoiceId: "PI-0001",
        status: "Draft",
        currencyCode: "USD"
      });
      expect(Number(invoices[0].exchangeRate)).toBe(1);
      const lines = await db
        .selectFrom("purchaseInvoiceLine")
        .selectAll()
        .where("companyId", "=", f.actor.companyId)
        .execute();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        invoiceLineType: "Consumable",
        itemId: f.itemId
      });
      expect(Number(lines[0].quantity)).toBe(2);
      const approved = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(approved.intake.attachmentStatus).toBe("Pending");
      const inbox = await getInvoiceIntakeInbox(db, f.actor);
      expect(inbox.intakes[0]).toMatchObject({
        sourceKinds: ["upload"],
        newItemCount: 0,
        newSupplierCount: 0
      });
      expect(inbox.budget).toMatchObject({
        todayActualUsd: "0",
        todayReservedUsd: "0"
      });
      expect(await counts(f)).toBe("0");
      await expect(
        approveInvoiceIntake(db, f.actor, {
          ...input,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/immutable/);
    }));
  it("groups identical new proposals, honors native supplier Pending policy, and rolls back a later creation failure", async () =>
    fixture(async (f) => {
      const value = review(f);
      value.supplierId = null;
      value.newSupplier = {
        supplier: { name: "New Synthetic Supplier", supplierStatus: "Active" }
      };
      value.lines[0].itemId = null;
      value.lines[0].newItem = {
        type: "Material",
        data: {
          id: "NEW-MATERIAL",
          name: "Synthetic Material",
          replenishmentSystem: "Buy",
          defaultMethodType: "Pull from Inventory",
          itemTrackingType: "Inventory",
          unitOfMeasureCode: "EA",
          unitCost: 5
        }
      };
      value.lines[0].lineType = "Material";
      value.lines.push({ ...value.lines[0], lineKey: "two", sortOrder: 1 });
      value.header.total = "20";
      value.header.subtotal = "20";
      await db
        .insertInto("approvalRule")
        .values({
          companyId: f.actor.companyId,
          lowerBoundAmount: 0,
          enabled: true,
          documentType: "supplier",
          createdBy: f.actor.userId
        })
        .execute();
      const row = await intake(f, value);
      const result = await approveInvoiceIntake(db, f.actor, {
        intakeId: row.id,
        expectedRevision: row.revision,
        approvalKey: randomUUID()
      });
      const loaded = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(new Set(loaded.review.lines.map((line) => line.itemId)).size).toBe(
        1
      );
      const supplier = await db
        .selectFrom("supplier")
        .select("supplierStatus")
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", loaded.review.supplierId!)
        .executeTakeFirstOrThrow();
      expect(supplier.supplierStatus).toBe("Pending");
      expect(result.status).toBe("Approved");
      const bad = review(f);
      bad.header.invoiceNumber = "EXAMPLE-ROLLBACK";
      bad.newSupplier = { supplier: { name: "Must Roll Back" } };
      bad.supplierId = null;
      bad.lines[0].itemId = null;
      bad.lines[0].newItem = {
        ...value.lines[0].newItem!,
        data: { ...value.lines[0].newItem!.data, id: "TEST-BOLT" }
      };
      bad.lines[0].lineType = "Material";
      const failed = await intake(f, bad);
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: failed.id,
          expectedRevision: failed.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow();
      expect(
        await db
          .selectFrom("supplier")
          .select("id")
          .where("companyId", "=", f.actor.companyId)
          .where("name", "=", "Must Roll Back")
          .execute()
      ).toHaveLength(0);
      expect(await counts(f)).toBe("0");
    }));
  it("links two partial payments without turning payment amounts into invoice amounts", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      const payments = await Promise.all([payment(f, 4), payment(f, 6)]);
      await attach(f, row.id, payments[0].id);
      await attach(f, row.id, payments[1].id);
      const result = await approveInvoiceIntake(db, f.actor, {
        intakeId: row.id,
        expectedRevision: row.revision,
        approvalKey: randomUUID()
      });
      const linked = await db
        .selectFrom("mercuryTransactionImport")
        .select(["purchaseInvoiceId", "reviewStatus"])
        .where("companyId", "=", f.actor.companyId)
        .execute();
      expect(linked).toHaveLength(2);
      expect(
        linked.every(
          (row) =>
            row.purchaseInvoiceId === result.invoiceId &&
            row.reviewStatus === "Imported"
        )
      ).toBe(true);
      expect(await counts(f)).toBe("0");
    }));
  it("serializes old Mercury and intake approval without deadlocks or orphan invoices", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      const paid = await payment(f);
      await attach(f, row.id, paid.id);
      const results = await Promise.allSettled([
        approveMercuryImport(db, {
          ...f.actor,
          importId: paid.id,
          supplierId: f.supplierId
        }),
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: row.revision,
          approvalKey: randomUUID()
        })
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true
      );
      expect(
        await db
          .selectFrom("purchaseInvoice")
          .select("id")
          .where("companyId", "=", f.actor.companyId)
          .execute()
      ).toHaveLength(1);
      expect(await counts(f)).toBe("0");
    }));
  it("rejects stale edited Draft tokens and preserves untouched manual lines during an explicit merge", async () =>
    fixture(async (f) => {
      const first = await intake(f);
      const original = await approveInvoiceIntake(db, f.actor, {
        intakeId: first.id,
        expectedRevision: first.revision,
        approvalKey: randomUUID()
      });
      const native = await db
        .selectFrom("purchaseInvoiceLine")
        .selectAll()
        .where("companyId", "=", f.actor.companyId)
        .where("invoiceId", "=", original.invoiceId)
        .executeTakeFirstOrThrow();
      const manual = await db
        .insertInto("purchaseInvoiceLine")
        .values({
          companyId: f.actor.companyId,
          invoiceId: original.invoiceId,
          invoiceLineType: "Comment",
          description: "Preserve manual note",
          sortOrder: 5,
          quantity: 0,
          createdBy: f.actor.userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const value = review(f);
      value.purchaseInvoiceId = original.invoiceId;
      value.mergeMode = "merge";
      const second = await db
        .insertInto("invoiceIntake")
        .values({
          companyId: f.actor.companyId,
          createdBy: f.actor.userId,
          purchaseInvoiceId: original.invoiceId,
          status: "NeedsReview"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await attach(f, second.id);
      const token = await getInvoiceIntakeReview(db, f.actor, second.id);
      value.expectedInvoiceUpdatedAt = token.linkedInvoice!.updatedAt;
      value.lines[0].purchaseInvoiceLineId = native.id;
      value.lines[0].review.expectedInvoiceLineUpdatedAt =
        token.invoiceLines.find((row) => row.value === native.id)!.updatedAt;
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: second.id,
        expectedRevision: 0,
        review: value
      });
      await db
        .updateTable("purchaseInvoice")
        .set({ updatedAt: sql<string>`now()`, updatedBy: f.actor.userId })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", original.invoiceId)
        .execute();
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: second.id,
          expectedRevision: saved.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/changed/);
      const refreshed = await getInvoiceIntakeReview(db, f.actor, second.id);
      value.expectedInvoiceUpdatedAt = refreshed.linkedInvoice!.updatedAt;
      const next = await saveInvoiceIntakeReview(db, f.actor, {
        id: second.id,
        expectedRevision: saved.revision,
        review: value
      });
      await approveInvoiceIntake(db, f.actor, {
        intakeId: second.id,
        expectedRevision: next.revision,
        approvalKey: randomUUID()
      });
      expect(
        await db
          .selectFrom("purchaseInvoiceLine")
          .select("description")
          .where("companyId", "=", f.actor.companyId)
          .where("id", "=", manual.id)
          .executeTakeFirst()
      ).toMatchObject({ description: "Preserve manual note" });
      expect(
        await db
          .selectFrom("purchaseInvoiceLine")
          .select("id")
          .where("companyId", "=", f.actor.companyId)
          .where("invoiceId", "=", original.invoiceId)
          .execute()
      ).toHaveLength(2);
      expect(await counts(f)).toBe("0");
    }));
  it("links posted invoice evidence without editing native records and refuses supplied foreign records", async () =>
    fixture(async (f) => {
      const first = await intake(f);
      const original = await approveInvoiceIntake(db, f.actor, {
        intakeId: first.id,
        expectedRevision: first.revision,
        approvalKey: randomUUID()
      });
      await db
        .updateTable("purchaseInvoice")
        .set({ status: "Paid" })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", original.invoiceId)
        .execute();
      const before = await db
        .selectFrom("purchaseInvoice")
        .selectAll()
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", original.invoiceId)
        .executeTakeFirstOrThrow();
      const value = invoiceIntakeReviewValidator.parse({
        purchaseInvoiceId: original.invoiceId,
        mergeMode: "evidence",
        header: {},
        lines: []
      });
      const row = await intake(f, value);
      await attach(f, row.id);
      expect(
        (
          await approveInvoiceIntake(db, f.actor, {
            intakeId: row.id,
            expectedRevision: row.revision,
            approvalKey: randomUUID()
          })
        ).status
      ).toBe("Linked");
      const after = await db
        .selectFrom("purchaseInvoice")
        .selectAll()
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", original.invoiceId)
        .executeTakeFirstOrThrow();
      expect(after).toEqual(before);
      const foreign = review(f);
      foreign.locationId = "unavailable-company-location";
      await expect(intake(f, foreign)).rejects.toThrow(/invalid selected/);
    }));
  it("keeps excluded extraction lines and retries explicit, with stale revision and revoked permission rejection", async () =>
    fixture(async (f) => {
      const value = review(f);
      const row = await intake(f, value);
      const extracted = emptyInvoiceExtraction();
      // Build complete synthetic evidence by expanding the contract's nullable field shape.
      const field = {
        value: null,
        confidence: null,
        sourceText: null,
        page: null
      };
      extracted.lines = [
        {
          lineKey: "missing",
          page: null,
          sourceText: null,
          description: field,
          supplierSku: field,
          manufacturerPartNumber: field,
          quantity: field,
          purchaseUnit: field,
          packText: field,
          unitPrice: field,
          discount: field,
          tax: field,
          taxPercent: field,
          shipping: field,
          lineTotal: field,
          suggestedType: field
        }
      ];
      await db
        .insertInto("documentExtraction")
        .values({
          companyId: f.actor.companyId,
          createdBy: f.actor.userId,
          intakeId: row.id,
          generation: 0,
          inputRevision: 0,
          attemptNumber: 1,
          operation: "extract",
          documentType: "purchaseInvoice",
          sourceDocument: "fixture.pdf",
          storagePath: f.actor.companyId + "/invoice-intake/fixture.pdf",
          status: "completed",
          extractedData: extracted
        })
        .execute();
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: row.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/every extracted line/);
      value.header.excludedLines = [
        {
          lineKey: "missing",
          reason: "Repeated print footer; no purchase value"
        }
      ];
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        review: value
      });
      expect(saved.status).toBe("Ready");
      await expect(
        setInvoiceIntakeStatus(db, f.actor, {
          id: row.id,
          expectedRevision: 0,
          action: "ignore"
        })
      ).rejects.toThrow(/changed/);
      await db
        .updateTable("employee")
        .set({ active: false })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", f.actor.userId)
        .execute();
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: saved.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/access/);
    }));
  it("requires a source, rejects duplicate invoice identity, and preserves a reviewed historical foreign rate", async () =>
    fixture(async (f) => {
      const blank = await db
        .insertInto("invoiceIntake")
        .values({ companyId: f.actor.companyId, createdBy: f.actor.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      const missing = await saveInvoiceIntakeReview(db, f.actor, {
        id: blank.id,
        expectedRevision: 0,
        review: review(f)
      });
      expect(missing.status).toBe("NeedsReview");
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: blank.id,
          expectedRevision: missing.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/Attach/);
      const first = await intake(f);
      await approveInvoiceIntake(db, f.actor, {
        intakeId: first.id,
        expectedRevision: first.revision,
        approvalKey: randomUUID()
      });
      const duplicate = await intake(f);
      expect(duplicate.status).toBe("NeedsReview");
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: duplicate.id,
          expectedRevision: duplicate.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/existing invoice|duplicate/i);
      await db
        .insertInto("currency")
        .values({
          code: "EUR",
          companyGroupId: f.groupId,
          createdBy: f.actor.userId,
          decimalPlaces: 2
        })
        .execute();
      const foreign = review(f);
      foreign.header.invoiceNumber = "EXAMPLE-FX";
      foreign.header.currencyCode = "EUR";
      foreign.historical = true;
      const staged = await intake(f, foreign);
      expect(staged.status).toBe("NeedsReview");
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: staged.id,
          expectedRevision: staged.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/exchange rate/i);
      foreign.header.exchangeRate = "1.234567";
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: staged.id,
        expectedRevision: staged.revision,
        review: foreign
      });
      const approved = await approveInvoiceIntake(db, f.actor, {
        intakeId: staged.id,
        expectedRevision: saved.revision,
        approvalKey: randomUUID()
      });
      const invoice = await db
        .selectFrom("purchaseInvoice")
        .select("exchangeRate")
        .select(sql<string>`"dateIssued"::text`.as("issueDate"))
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", approved.invoiceId)
        .executeTakeFirstOrThrow();
      expect(Number(invoice.exchangeRate)).toBe(1.234567);
      expect(invoice.issueDate).toBe("2026-02-28");
      expect(await counts(f)).toBe("0");
    }));
  it("versions supplier corrections and guards stale or invalid rule edits", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      await approveInvoiceIntake(db, f.actor, {
        intakeId: row.id,
        expectedRevision: row.revision,
        approvalKey: randomUUID()
      });
      const loaded = await getInvoiceIntakeReview(db, f.actor, row.id);
      const alias = loaded.rules.find((rule) => rule.kind === "supplierAlias")!;
      const replacement = await db
        .insertInto("supplier")
        .values({
          companyId: f.actor.companyId,
          createdBy: f.actor.userId,
          name: "Replacement Synthetic Supplier",
          supplierStatus: "Active"
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await expect(
        updateInvoiceRecognitionRule(db, f.actor, {
          id: alias.id,
          action: "replace",
          expectedVersion: alias.version,
          supplierId: "foreign-supplier",
          reason: "Synthetic correction"
        })
      ).rejects.toThrow(/active supplier/);
      const revised = await updateInvoiceRecognitionRule(db, f.actor, {
        id: alias.id,
        action: "replace",
        expectedVersion: alias.version,
        supplierId: replacement.id,
        reason: "Corrected synthetic identity"
      });
      expect(revised.version).toBe(2);
      await expect(
        updateInvoiceRecognitionRule(db, f.actor, {
          id: alias.id,
          action: "disable",
          expectedVersion: alias.version
        })
      ).rejects.toThrow(/changed/);
      const history = await db
        .selectFrom("invoiceRecognitionRule")
        .selectAll()
        .where("companyId", "=", f.actor.companyId)
        .where("kind", "=", "supplierAlias")
        .orderBy("version")
        .execute();
      expect(history).toHaveLength(2);
      expect(history[0].active).toBe(false);
      expect(history[1]).toMatchObject({
        supplierId: replacement.id,
        supersedesId: alias.id,
        active: true
      });
      expect(history[1].sourceText).toContain("Corrected synthetic identity");
      expect(
        (
          await updateInvoiceRecognitionRule(db, f.actor, {
            id: revised.id,
            action: "disable",
            expectedVersion: revised.version
          })
        ).active
      ).toBe(false);
      expect(await counts(f)).toBe("0");
    }));
  it("canonicalizes only configured native defaults and never overwrites a newer review", async () =>
    fixture(async (f) => {
      await db
        .insertInto("employeeJob")
        .values({
          id: f.actor.userId,
          companyId: f.actor.companyId,
          locationId: f.locationId
        })
        .onConflict((oc) =>
          oc
            .columns(["id", "companyId"])
            .doUpdateSet({ locationId: f.locationId })
        )
        .execute();
      const prepare = async (value: InvoiceIntakeReview) => {
        const row = await intake(f, value);
        const attempt = await db
          .insertInto("documentExtraction")
          .values({
            companyId: f.actor.companyId,
            createdBy: f.actor.userId,
            intakeId: row.id,
            generation: 0,
            inputRevision: row.revision - 1,
            attemptNumber: 1,
            operation: "extract",
            documentType: "purchaseInvoice",
            sourceDocument: "fixture.pdf",
            storagePath: f.actor.companyId + "/invoice-intake/fixture.pdf",
            status: "completed",
            extractedData: emptyInvoiceExtraction()
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await db
          .updateTable("invoiceIntake")
          .set({ activeExtractionId: attempt.id, status: "NeedsReview" })
          .where("companyId", "=", f.actor.companyId)
          .where("id", "=", row.id)
          .execute();
        return {
          ...f.actor,
          db,
          intakeId: row.id,
          generation: 0,
          expectedRevision: row.revision,
          attemptId: attempt.id
        };
      };
      const missingDefaults = review(f);
      missingDefaults.locationId = null;
      missingDefaults.lines[0].locationId = null;
      missingDefaults.lines[0].stockUnit = null;
      missingDefaults.lines[0].conversionFactor = null;
      const configured = await prepare(missingDefaults);
      expect(await validateHydratedInvoiceIntake(configured)).toMatchObject({
        validated: true,
        revision: configured.expectedRevision + 1
      });
      const ready = await getInvoiceIntakeReview(
        db,
        f.actor,
        configured.intakeId
      );
      expect(ready.intake.status).toBe("Ready");
      expect(ready.review.lines[0]).toMatchObject({
        stockUnit: "EA",
        conversionFactor: "1",
        locationId: f.locationId
      });
      const unknown = review(f);
      unknown.lines[0].itemId = null;
      unknown.lines[0].stockUnit = null;
      const unresolved = await prepare(unknown);
      await validateHydratedInvoiceIntake(unresolved);
      expect(
        (await getInvoiceIntakeReview(db, f.actor, unresolved.intakeId)).intake
          .status
      ).toBe("NeedsReview");
      const changed = await prepare(missingDefaults);
      const corrected = review(f);
      corrected.header.invoiceNumber = "HUMAN-EDIT";
      await saveInvoiceIntakeReview(db, f.actor, {
        id: changed.intakeId,
        expectedRevision: changed.expectedRevision,
        review: corrected
      });
      expect(await validateHydratedInvoiceIntake(changed)).toEqual({
        validated: false
      });
      expect(
        (await getInvoiceIntakeReview(db, f.actor, changed.intakeId)).review
          .header.invoiceNumber
      ).toBe("HUMAN-EDIT");
    }));
  it("restores ignored source payments together with their intake", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      const paid = await payment(f);
      await attach(f, row.id, paid.id);
      await db
        .updateTable("mercuryTransactionImport")
        .set({ reviewStatus: "Ignored" })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", paid.id)
        .execute();
      const ignored = await setInvoiceIntakeStatus(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        action: "ignore"
      });
      await setInvoiceIntakeStatus(db, f.actor, {
        id: row.id,
        expectedRevision: ignored.revision,
        action: "restore"
      });
      expect(
        await db
          .selectFrom("mercuryTransactionImport")
          .select("reviewStatus")
          .where("companyId", "=", f.actor.companyId)
          .where("id", "=", paid.id)
          .executeTakeFirst()
      ).toEqual({ reviewStatus: "Pending" });
    }));
});
