import { randomUUID } from "node:crypto";
import {
  getPostgresConnectionPool,
  type KyselyDatabase,
  type KyselyTx
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
const { createReviewedItem, prepareReviewedItemCreations } = await import(
  "./items.server"
);
const { createReviewedSupplier } = await import(
  "../purchasing/purchasing.server"
);

import type { ReviewedItemInput, ReviewedMasterActor } from "./items.server";

const databaseUrl = process.env.INVOICE_INTAKE_TEST_DATABASE_URL;
let db: Kysely<KyselyDatabase>;
class FixtureRollback extends Error {}

beforeAll(() => {
  if (
    !databaseUrl ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)
  ) {
    throw new Error(
      "Invoice intake integration tests require an explicitly configured local database"
    );
  }
  process.env.SUPABASE_DB_URL = databaseUrl;
  db = new Kysely<KyselyDatabase>({
    dialect: new PostgresDialect({ pool: getPostgresConnectionPool(2) })
  });
});
afterAll(async () => {
  if (db) await db.destroy();
});

async function fixture(
  run: (trx: KyselyTx, actor: ReviewedMasterActor) => Promise<void>
) {
  try {
    await db.transaction().execute(async (trx) => {
      const userId = randomUUID();
      await trx
        .insertInto("user")
        .values({ id: userId, email: `${userId}@example.com` })
        .execute();
      const company = await trx
        .insertInto("company")
        .values({ name: "Reviewed Master Fixture", baseCurrencyCode: "USD" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const companyId = company.id;
      await trx
        .insertInto("customFieldTable")
        .values([
          { table: "part", name: "Part", module: "Parts" },
          { table: "material", name: "Material", module: "Parts" }
        ])
        .onConflict((oc) => oc.column("table").doNothing())
        .execute();
      await trx
        .insertInto("attributeDataType")
        .values({ id: 5, label: "Text", isText: true })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      await trx
        .insertInto("sequence")
        .values({
          table: "supplier",
          name: "Supplier",
          prefix: "SUP-",
          next: 0,
          step: 1,
          size: 4,
          companyId
        })
        .execute();
      await trx
        .insertInto("unitOfMeasure")
        .values({ code: "EA", name: "Each", companyId, createdBy: userId })
        .execute();
      await run(trx, { companyId, userId });
      throw new FixtureRollback();
    });
  } catch (error) {
    if (!(error instanceof FixtureRollback)) throw error;
  }
}

function proposal(
  type: ReviewedItemInput["type"],
  overrides: Record<string, unknown> = {}
): ReviewedItemInput {
  return {
    type,
    data: {
      id: `TEST-${type}`,
      name: `Synthetic ${type}`,
      revision: "0",
      description: "Synthetic fixture",
      replenishmentSystem: "Buy",
      defaultMethodType: "Pull from Inventory",
      itemTrackingType: type === "Service" ? "Non-Inventory" : "Inventory",
      unitOfMeasureCode: "EA",
      unitCost: 2.75,
      shelfLifeCalculateFromBom: false,
      ...overrides
    }
  };
}

describe("Reviewed supplier and typed item creation", () => {
  it("requires and preserves custom fields that apply to the proposed item's tags", async () => {
    await fixture(async (trx, actor) => {
      const field = await trx
        .insertInto("customField")
        .values({
          table: "part",
          name: "Tagged trace code",
          tags: ["traceable"],
          required: true,
          dataTypeId: 5,
          companyId: actor.companyId,
          createdBy: actor.userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const input = proposal("Part", { tags: ["traceable"] });
      await expect(
        prepareReviewedItemCreations(trx, actor, [input])
      ).rejects.toThrow("required custom field");
      input.customFields = { [field.id]: "synthetic trace" };
      await createReviewedItem(trx, actor, input);
      const result = await trx
        .selectFrom("part")
        .select("customFields")
        .where("companyId", "=", actor.companyId)
        .executeTakeFirstOrThrow();
      expect(result.customFields).toEqual({ [field.id]: "synthetic trace" });
      await expect(
        prepareReviewedItemCreations(trx, actor, [
          {
            ...proposal("Part", { id: "OTHER", tags: ["unrelated"] }),
            customFields: input.customFields
          }
        ])
      ).rejects.toThrow("unavailable");
    });
  });
  it("creates all native subtype companions and defaults without inventory or accounting entries", async () => {
    await fixture(async (trx, actor) => {
      const proposals = (
        ["Part", "Material", "Consumable", "Tool", "Service"] as const
      ).map((type) => proposal(type));
      const context = await prepareReviewedItemCreations(trx, actor, proposals);
      for (const input of proposals)
        await createReviewedItem(trx, actor, input, context);
      const rows = await sql<{
        type: string;
        companion: string | null;
        readableId: string;
        itemTrackingType: string;
        unitCost: string;
      }>`
        SELECT i.type,i."readableId",i."itemTrackingType",c."unitCost",
          COALESCE(p.id,m.id,co.id,t.id,s.id) companion
        FROM item i JOIN "itemCost" c ON c."itemId"=i.id AND c."companyId"=i."companyId"
        LEFT JOIN part p ON p.id=i."readableId" AND p."companyId"=i."companyId"
        LEFT JOIN material m ON m.id=i."readableId" AND m."companyId"=i."companyId"
        LEFT JOIN consumable co ON co.id=i."readableId" AND co."companyId"=i."companyId"
        LEFT JOIN tool t ON t.id=i."readableId" AND t."companyId"=i."companyId"
        LEFT JOIN service s ON s.id=i."readableId" AND s."companyId"=i."companyId"
        WHERE i."companyId"=${actor.companyId}
      `.execute(trx);
      expect(rows.rows).toHaveLength(5);
      for (const row of rows.rows) {
        expect(row.companion).toBe(row.readableId);
        expect(Number(row.unitCost)).toBe(2.75);
      }
      expect(
        rows.rows.find((row) => row.type === "Service")?.itemTrackingType
      ).toBe("Non-Inventory");
      const ledger = await sql<{ count: string }>`SELECT (
        (SELECT count(*) FROM "itemLedger" WHERE "companyId"=${actor.companyId}) +
        (SELECT count(*) FROM "costLedger" WHERE "companyId"=${actor.companyId}) +
        (SELECT count(*) FROM receipt WHERE "companyId"=${actor.companyId}) +
        (SELECT count(*) FROM "journalLine" WHERE "companyId"=${actor.companyId})
      )::text count`.execute(trx);
      expect(ledger.rows[0].count).toBe("0");
    });
  });

  it("preserves material sizes, custom fields, pick location and shelf-life defaults", async () => {
    await fixture(async (trx, actor) => {
      const location = await trx
        .insertInto("location")
        .values({
          name: "Fixture Warehouse",
          addressLine1: "1 Test Road",
          city: "Test",
          postalCode: "00000",
          timezone: "UTC",
          companyId: actor.companyId,
          createdBy: actor.userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const storage = await trx
        .insertInto("storageUnit")
        .values({
          name: "Fixture Bin",
          locationId: location.id,
          companyId: actor.companyId,
          createdBy: actor.userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const field = await trx
        .insertInto("customField")
        .values({
          table: "material",
          name: "Trace code",
          required: true,
          dataTypeId: 5,
          companyId: actor.companyId,
          createdBy: actor.userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const input = proposal("Material", {
        sizes: ["1in", "2in"],
        defaultStorageUnitId: storage.id,
        itemTrackingType: "Batch",
        shelfLifeMode: "Fixed Duration",
        shelfLifeDays: 30
      });
      input.customFields = { [field.id]: "synthetic" };
      const result = await createReviewedItem(trx, actor, input);
      expect(result.items).toHaveLength(2);
      const material = await trx
        .selectFrom("material")
        .select(["id", "customFields"])
        .where("companyId", "=", actor.companyId)
        .executeTakeFirstOrThrow();
      expect(material).toEqual({
        id: "TEST-Material",
        customFields: { [field.id]: "synthetic" }
      });
      const picks = await trx
        .selectFrom("pickMethod")
        .select(["locationId", "defaultStorageUnitId"])
        .where("companyId", "=", actor.companyId)
        .execute();
      expect(picks).toHaveLength(2);
      expect(
        picks.every(
          (row) =>
            row.defaultStorageUnitId === storage.id &&
            row.locationId === location.id
        )
      ).toBe(true);
      const shelf = await trx
        .selectFrom("itemShelfLife")
        .select(["mode", "days", "triggerTiming", "calculateFromBom"])
        .where("companyId", "=", actor.companyId)
        .execute();
      expect(shelf).toHaveLength(2);
      expect(shelf[0]).toMatchObject({
        mode: "Fixed Duration",
        days: 30,
        triggerTiming: "After",
        calculateFromBom: false
      });
    });
  });

  it("requires declared custom fields and rejects foreign-company references before inserts", async () => {
    await fixture(async (trx, actor) => {
      await trx
        .insertInto("customField")
        .values({
          table: "part",
          name: "Required",
          required: true,
          dataTypeId: 5,
          companyId: actor.companyId,
          createdBy: actor.userId
        })
        .execute();
      await expect(
        createReviewedItem(trx, actor, proposal("Part"))
      ).rejects.toThrow("required custom field");
      await expect(
        createReviewedItem(
          trx,
          actor,
          proposal("Tool", { defaultStorageUnitId: "foreign-storage" })
        )
      ).rejects.toThrow("unavailable in this company");
      expect(
        await trx
          .selectFrom("item")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(0);
    });
  });

  it("enforces supplier approval policy and lets native interceptors create organization/default records", async () => {
    await fixture(async (trx, actor) => {
      await trx
        .insertInto("approvalRule")
        .values({
          documentType: "supplier",
          enabled: true,
          lowerBoundAmount: 0,
          companyId: actor.companyId,
          createdBy: actor.userId
        })
        .execute();
      const result = await createReviewedSupplier(trx, actor, {
        supplier: { name: "Synthetic Vendor", supplierStatus: "Active" },
        contact: { email: "billing@vendor.example.com", firstName: "Billing" },
        address: { name: "Primary", addressLine1: "2 Test Road" },
        tax: { taxId: "SYNTHETIC-TAX" }
      });
      expect(result.supplierStatus).toBe("Pending");
      expect(result.readableId).toBe("SUP-0001");
      expect(result.supplierContactId).toBeTruthy();
      expect(result.supplierLocationId).toBeTruthy();
      const defaults = await sql<{
        payments: string;
        shipping: string;
        tax: string;
        groups: string;
      }>`SELECT
        (SELECT count(*) FROM "supplierPayment" WHERE "supplierId"=${result.supplierId})::text payments,
        (SELECT count(*) FROM "supplierShipping" WHERE "supplierId"=${result.supplierId})::text shipping,
        (SELECT count(*) FROM "supplierTax" WHERE "supplierId"=${result.supplierId} AND "taxId"='SYNTHETIC-TAX')::text tax,
        (SELECT count(*) FROM "group" WHERE id=${result.supplierId} AND "isSupplierOrgGroup")::text groups`.execute(
        trx
      );
      expect(defaults.rows[0]).toEqual({
        payments: "1",
        shipping: "1",
        tax: "1",
        groups: "1"
      });
    });
  });
});
