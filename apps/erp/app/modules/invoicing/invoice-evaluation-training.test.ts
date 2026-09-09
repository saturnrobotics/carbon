import { createHash, randomUUID } from "node:crypto";
import {
  getPostgresConnectionPool,
  type KyselyDatabase
} from "@carbon/database/client";

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
const { saveInvoiceIntakeReview } = await import("./invoicing.server");
const {
  prepareInvoiceEvaluationCatalog,
  teachInvoiceEvaluationFixture,
  expectedInvoiceRepeat
} = await import("./invoice-evaluation-training.server");
const { extractionToInvoiceReview } = await import("./invoice-intake.utils");
const { createReviewedItem } = await import("../items/items.server");

import { syntheticInvoiceFixtures } from "../../../../../packages/jobs/src/invoice-intake/fixtures/synthetic";
import { resolveInvoiceCandidates } from "../../../../../packages/jobs/src/invoice-intake/recognition";

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
        .values({ name: "Invoice Inference Evaluation Fixture" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const company = await trx
        .insertInto("company")
        .values({
          name: "Invoice Inference Evaluation Fixture",
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

describe("synthetic invoice teaching", () => {
  // This complete 20-document corpus exercises thousands of real SQL statements.
  // Keep its bounded integration budget separate from the default unit-test limit.
  it(
    "approves all five native item classes and learns held-out supplier/pack identities without stock or accounting writes",
    { timeout: 30_000 },
    async () =>
      fixture(async (f) => {
        const fixtures = syntheticInvoiceFixtures();
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
        const catalog = await prepareInvoiceEvaluationCatalog(
          db,
          f.actor,
          fixtures
        );
        for (const source of fixtures.slice(0, 20)) {
          const row = await db
            .insertInto("invoiceIntake")
            .values({
              companyId: f.actor.companyId,
              createdBy: f.actor.userId,
              status: "NeedsReview"
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await db
            .insertInto("invoiceIntakeSource")
            .values({
              companyId: f.actor.companyId,
              intakeId: row.id,
              createdBy: f.actor.userId,
              kind: "upload",
              sourceKey: source.id,
              storageBucket: "private",
              storagePath: `${f.actor.companyId}/invoice-intake/${row.id}/source.pdf`,
              sha256: createHash("sha256")
                .update(JSON.stringify(source.labels))
                .digest("hex"),
              mediaType: "application/pdf",
              byteSize: 120,
              fileName: "fixture.pdf"
            })
            .execute();
          await db
            .insertInto("invoiceIntakeLine")
            .values(
              source.labels.lines.map((line, index) => ({
                companyId: f.actor.companyId,
                intakeId: row.id,
                lineKey: line.lineKey,
                sortOrder: index,
                raw: line,
                createdBy: f.actor.userId
              }))
            )
            .execute();
          await saveInvoiceIntakeReview(db, f.actor, {
            id: row.id,
            expectedRevision: row.revision,
            review: extractionToInvoiceReview(source.labels)
          });
          await teachInvoiceEvaluationFixture(
            db,
            f.actor,
            row.id,
            source,
            catalog
          );
        }
        expect(catalog.suppliers.size).toBe(3);
        expect(catalog.items.size).toBe(5);
        for (const source of fixtures.filter(
          (fixture) => fixture.heldOutRepeat
        )) {
          const expected = expectedInvoiceRepeat(catalog, source);
          const actual = await resolveInvoiceCandidates(db, f.actor.companyId, {
            supplierName: source.labels.supplier.name.value,
            lines: source.labels.lines.map((line) => ({
              lineKey: line.lineKey,
              description: line.description.value,
              supplierSku: line.supplierSku.value,
              manufacturerPartNumber: line.manufacturerPartNumber.value,
              purchaseUnit: line.purchaseUnit.value,
              packText: line.packText.value
            }))
          });
          expect(actual.supplierId).toBe(expected.supplierId);
          expect(
            actual.lines.map((line) => ({
              itemId: line.itemId,
              purchaseUnit: line.purchaseUnit,
              stockUnit: line.stockUnit,
              conversionFactor:
                line.conversionFactor === null
                  ? null
                  : String(line.conversionFactor)
            }))
          ).toEqual(expected.lines);
        }
        const invoices = await db
          .selectFrom("purchaseInvoice")
          .select("status")
          .where("companyId", "=", f.actor.companyId)
          .execute();
        expect(invoices).toHaveLength(15);
        expect(invoices.every((invoice) => invoice.status === "Draft")).toBe(
          true
        );
        const counts = await sql<{
          count: string;
        }>`SELECT ((SELECT count(*) FROM "itemLedger" WHERE "companyId"=${f.actor.companyId})+(SELECT count(*) FROM "costLedger" WHERE "companyId"=${f.actor.companyId})+(SELECT count(*) FROM receipt WHERE "companyId"=${f.actor.companyId})+(SELECT count(*) FROM journal WHERE "companyId"=${f.actor.companyId})+(SELECT count(*) FROM payment WHERE "companyId"=${f.actor.companyId}))::text count`.execute(
          db
        );
        expect(counts.rows[0].count).toBe("0");
      })
  );
});
