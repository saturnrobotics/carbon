import { execFileSync } from "node:child_process";
import {
  getPostgresConnectionPool,
  type KyselyDatabase
} from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

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

const { createProcurementDraft } = await import("./purchasing.service");

const databaseUrl = process.env.PROCUREMENT_DRAFT_TEST_DATABASE_URL;
const disposableContainer =
  process.env.PROCUREMENT_DRAFT_TEST_CONTAINER ?? "knowledge-schema-test";

type DockerInspection = {
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostPort?: string }> | null>;
  };
};

/** A destructive test may only target the explicitly labelled disposable container.
 * Checking the Docker port mapping prevents a localhost URL from silently naming a
 * developer PostgreSQL process instead of that container. */
function isExplicitDisposableDatabase(url: URL): boolean {
  if (
    process.env.PROCUREMENT_DRAFT_TEST_DATABASE_DISPOSABLE !== "1" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.port === "" ||
    url.port === "5432" ||
    url.pathname !== "/procurement_draft_test" ||
    url.username !== "knowledge_test_migrator"
  ) {
    return false;
  }
  try {
    const inspected = JSON.parse(
      execFileSync("docker", ["inspect", disposableContainer], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    ) as DockerInspection[];
    const container = inspected[0];
    const ports = container?.NetworkSettings?.Ports?.["5432/tcp"] ?? [];
    return (
      container?.Config?.Labels?.["knowledge.disposable"] === "true" &&
      ports.some((port) => port.HostPort === url.port)
    );
  } catch {
    return false;
  }
}

const enabled = (() => {
  if (!databaseUrl) return false;
  return isExplicitDisposableDatabase(new URL(databaseUrl));
})();

function assertDisposableDatabase() {
  if (!databaseUrl || !isExplicitDisposableDatabase(new URL(databaseUrl))) {
    throw new Error(
      "Refusing to drop schemas without the explicitly labelled disposable PostgreSQL fixture"
    );
  }
}

let db: Kysely<KyselyDatabase>;

const actor = "user-procurement";
const companyId = "company-procurement";
const companyGroupId = "group-procurement";
const supplierId = "supplier-procurement";
const locationId = "location-procurement";
const itemReadableId = "PART-100";
const currentRevisionId = "item-revision-current";
const previousRevisionId = "item-revision-previous";
const payloadHash = "a".repeat(64);

const input = (
  overrides: Partial<Parameters<typeof createProcurementDraft>[2]> = {}
) => ({
  idempotencyKey: "procurement-command-1",
  payloadHash,
  supplierId,
  receivingLocationId: locationId,
  orderDate: "2026-09-07",
  lines: [
    {
      itemId: itemReadableId,
      itemRevisionId: currentRevisionId,
      quantity: 2,
      purchaseUnitOfMeasureCode: "BOX",
      inventoryUnitOfMeasureCode: "EA",
      conversionFactor: 10,
      supplierUnitPrice: 1.25
    }
  ],
  ...overrides
});

async function installSchema() {
  await sql
    .raw(`
    DROP SCHEMA IF EXISTS knowledge CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    CREATE SCHEMA knowledge;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE company (id text PRIMARY KEY, "baseCurrencyCode" text NOT NULL);
    CREATE TABLE currency (code text NOT NULL, "companyGroupId" text NOT NULL, "decimalPlaces" integer NOT NULL, active boolean NOT NULL, PRIMARY KEY (code, "companyGroupId"));
    CREATE TABLE supplier (id text PRIMARY KEY, "companyId" text NOT NULL, "currencyCode" text, "supplierStatus" text, "taxPercent" numeric NOT NULL DEFAULT 0);
    CREATE TABLE location (id text PRIMARY KEY, "companyId" text NOT NULL);
    CREATE TABLE "supplierPayment" ("supplierId" text PRIMARY KEY, "companyId" text NOT NULL, "invoiceSupplierId" text, "invoiceSupplierContactId" text, "invoiceSupplierLocationId" text, "paymentTermId" text, "currencyCode" text);
    CREATE TABLE "supplierShipping" ("supplierId" text PRIMARY KEY, "companyId" text NOT NULL, "shippingMethodId" text, "shippingTermId" text, incoterm text, "incotermLocation" text);
    CREATE TABLE item (id text PRIMARY KEY, "companyId" text NOT NULL, "readableId" text NOT NULL, "readableIdWithRevision" text, description text, type text NOT NULL, "unitOfMeasureCode" text, "revisionStatus" text NOT NULL, "changeOrderId" text, revision text, "createdAt" timestamptz NOT NULL DEFAULT now());
    CREATE TABLE "changeOrder" (id text PRIMARY KEY, "companyId" text NOT NULL, status text NOT NULL);
    CREATE TABLE "itemReplenishment" ("itemId" text PRIMARY KEY, "companyId" text NOT NULL, "purchasingBlocked" boolean NOT NULL DEFAULT false, "purchasingUnitOfMeasureCode" text, "conversionFactor" numeric NOT NULL DEFAULT 1);
    CREATE TABLE "supplierPart" (id text PRIMARY KEY, "supplierId" text NOT NULL, "itemId" text NOT NULL, "companyId" text NOT NULL, active boolean NOT NULL, "supplierUnitOfMeasureCode" text, "conversionFactor" numeric NOT NULL, "unitPrice" numeric);
    CREATE TABLE sequence ("table" text NOT NULL, "companyId" text NOT NULL, next integer NOT NULL, PRIMARY KEY ("table", "companyId"));
    CREATE OR REPLACE FUNCTION get_next_sequence(sequence_name text, company_id text) RETURNS text LANGUAGE plpgsql AS $$
    DECLARE next_value integer;
    BEGIN
      UPDATE sequence SET next = next + 1 WHERE "table" = sequence_name AND "companyId" = company_id RETURNING next INTO next_value;
      IF NOT FOUND THEN RAISE EXCEPTION 'sequence not found'; END IF;
      RETURN 'PO-' || lpad(next_value::text, 6, '0');
    END;
    $$;
    CREATE TABLE "supplierInteraction" (id text PRIMARY KEY DEFAULT ('si-' || gen_random_uuid()::text), "companyId" text NOT NULL, "supplierId" text NOT NULL);
    CREATE TABLE "purchaseOrder" (id text PRIMARY KEY DEFAULT ('po-' || gen_random_uuid()::text), "purchaseOrderId" text NOT NULL UNIQUE, "purchaseOrderType" text NOT NULL, status text NOT NULL, "supplierId" text NOT NULL, "supplierInteractionId" text NOT NULL, "orderDate" date, "currencyCode" text, "exchangeRate" numeric, "exchangeRateUpdatedAt" timestamptz, "companyId" text NOT NULL, "createdBy" text NOT NULL, "updatedBy" text);
    CREATE TABLE "purchaseOrderDelivery" (id text PRIMARY KEY, "locationId" text, "shippingMethodId" text, "shippingTermId" text, incoterm text, "incotermLocation" text, "companyId" text NOT NULL);
    CREATE TABLE "purchaseOrderPayment" (id text PRIMARY KEY, "paymentTermId" text, "invoiceSupplierId" text, "invoiceSupplierContactId" text, "invoiceSupplierLocationId" text, "companyId" text NOT NULL);
    CREATE TABLE "purchaseOrderLine" (id text PRIMARY KEY DEFAULT ('pol-' || gen_random_uuid()::text), "purchaseOrderId" text NOT NULL, "purchaseOrderLineType" text NOT NULL, "itemId" text, description text, "purchaseQuantity" numeric, "purchaseUnitOfMeasureCode" text, "inventoryUnitOfMeasureCode" text, "conversionFactor" numeric, "supplierPartId" text, "supplierUnitPrice" numeric, "supplierTaxAmount" numeric NOT NULL DEFAULT 0, "taxPercent" numeric NOT NULL DEFAULT 0, "exchangeRate" numeric NOT NULL DEFAULT 1, "locationId" text, "sortOrder" integer NOT NULL, "companyId" text NOT NULL, "createdBy" text NOT NULL, "updatedBy" text);
    CREATE TABLE "knowledgeCommandReceipt" (id text PRIMARY KEY DEFAULT ('kcmd-' || gen_random_uuid()::text), "companyId" text NOT NULL, "actorId" text NOT NULL, action text NOT NULL, "idempotencyKey" text NOT NULL, "payloadHash" text NOT NULL, "purchaseOrderId" text NOT NULL, UNIQUE ("companyId", "actorId", action, "idempotencyKey"));
    CREATE TABLE knowledge.source (id text PRIMARY KEY, "companyId" text NOT NULL, kind text NOT NULL, status text NOT NULL);
    CREATE TABLE knowledge.outbox (id text PRIMARY KEY DEFAULT ('kout-' || gen_random_uuid()::text), "companyId" text NOT NULL, "createdBy" text NOT NULL, "sourceId" text NOT NULL, "entityType" text NOT NULL, "entityId" text NOT NULL, "sourceVersion" text NOT NULL, "eventType" text NOT NULL, payload jsonb NOT NULL, UNIQUE ("companyId", "sourceId", "entityType", "entityId", "sourceVersion", "eventType"));
  `)
    .execute(db);
}

async function seed() {
  await sql
    .raw(`
    TRUNCATE knowledge.outbox, knowledge.source, "knowledgeCommandReceipt", "purchaseOrderLine", "purchaseOrderPayment", "purchaseOrderDelivery", "purchaseOrder", "supplierInteraction", sequence, "supplierPart", "itemReplenishment", "changeOrder", item, "supplierShipping", "supplierPayment", location, supplier, currency, company;
    INSERT INTO company VALUES ('${companyId}', 'USD');
    INSERT INTO knowledge.source VALUES ('carbon-purchasing-source', '${companyId}', 'carbon', 'active');
    INSERT INTO currency VALUES ('USD', '${companyGroupId}', 2, true);
    INSERT INTO supplier VALUES ('${supplierId}', '${companyId}', 'USD', 'Active', 0.1);
    INSERT INTO location VALUES ('${locationId}', '${companyId}');
    INSERT INTO "supplierPayment" VALUES ('${supplierId}', '${companyId}', '${supplierId}', NULL, NULL, 'net-30', 'USD');
    INSERT INTO "supplierShipping" VALUES ('${supplierId}', '${companyId}', 'ground', 'standard', NULL, NULL);
    INSERT INTO item (id, "companyId", "readableId", "readableIdWithRevision", description, type, "unitOfMeasureCode", "revisionStatus", revision, "createdAt") VALUES
      ('${previousRevisionId}', '${companyId}', '${itemReadableId}', '${itemReadableId}.A', 'Previous revision', 'Part', 'EA', 'Production', 'A', '2026-01-01T00:00:00Z'),
      ('${currentRevisionId}', '${companyId}', '${itemReadableId}', '${itemReadableId}.B', 'Current revision', 'Part', 'EA', 'Production', 'B', '2026-02-01T00:00:00Z');
    INSERT INTO "itemReplenishment" VALUES ('${currentRevisionId}', '${companyId}', false, 'BOX', 10);
    INSERT INTO "supplierPart" VALUES ('supplier-part-current', '${supplierId}', '${currentRevisionId}', '${companyId}', true, 'BOX', 10, 1.25);
    INSERT INTO sequence VALUES ('purchaseOrder', '${companyId}', 0);
  `)
    .execute(db);
}

async function count(table: string) {
  const result = await sql<{
    count: string;
  }>`select count(*)::text as count from ${sql.table(table)}`.execute(db);
  return Number(result.rows[0]?.count ?? 0);
}

describe.skipIf(!enabled)(
  "createProcurementDraft against disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      process.env.SUPABASE_DB_URL = databaseUrl!;
      db = new Kysely<KyselyDatabase>({
        dialect: new PostgresDialect({ pool: getPostgresConnectionPool(4) })
      });
      assertDisposableDatabase();
      await installSchema();
    });

    beforeEach(seed);

    afterAll(async () => {
      if (db) {
        await sql
          .raw(
            "DROP SCHEMA IF EXISTS knowledge CASCADE; DROP SCHEMA IF EXISTS public CASCADE"
          )
          .execute(db);
        await db.destroy();
      }
    });

    const context = {
      companyId,
      companyGroupId,
      actorId: actor,
      canCreatePurchasing: true,
      knowledgeSourceId: "carbon-purchasing-source"
    };

    it("writes a Draft PO with Carbon supplier defaults, line tax, and one receipt", async () => {
      const result = await createProcurementDraft(db, context, input());

      expect(result.replayed).toBe(false);
      expect(await count("purchaseOrder")).toBe(1);
      expect(await count("purchaseOrderLine")).toBe(1);
      expect(await count("purchaseOrderPayment")).toBe(1);
      expect(await count("purchaseOrderDelivery")).toBe(1);
      expect(await count("knowledgeCommandReceipt")).toBe(1);
      const outbox = await sql<{
        count: string;
      }>`select count(*)::text as count from knowledge.outbox`.execute(db);
      expect(Number(outbox.rows[0]?.count ?? 0)).toBe(1);
      const line = await sql<{
        supplierUnitPrice: number;
        supplierTaxAmount: number;
        conversionFactor: number;
      }>`
      select "supplierUnitPrice", "supplierTaxAmount", "conversionFactor" from "purchaseOrderLine"
    `.execute(db);
      expect(line.rows[0]).toMatchObject({
        supplierUnitPrice: 1.25,
        supplierTaxAmount: 0.25,
        conversionFactor: 10
      });
    });

    it("rolls back every write when the supplier is invalid", async () => {
      await expect(
        createProcurementDraft(
          db,
          context,
          input({ supplierId: "missing-supplier" })
        )
      ).rejects.toThrow("Supplier is not an active supplier");

      expect(await count("purchaseOrder")).toBe(0);
      expect(await count("purchaseOrderLine")).toBe(0);
      expect(await count("knowledgeCommandReceipt")).toBe(0);
    });

    it("rejects a non-current revision before allocating a PO or receipt", async () => {
      await expect(
        createProcurementDraft(
          db,
          context,
          input({
            lines: [{ ...input().lines[0], itemRevisionId: previousRevisionId }]
          })
        )
      ).rejects.toThrow("no longer the current released revision");

      expect(await count("purchaseOrder")).toBe(0);
      expect(await count("knowledgeCommandReceipt")).toBe(0);
    });

    it("reuses the unreleased-ECO guard before allocating a PO or receipt", async () => {
      await sql`
        insert into "changeOrder" (id, "companyId", status)
        values ('eco-open', ${companyId}, 'Draft')
      `.execute(db);
      await sql`
        update item set "changeOrderId" = 'eco-open' where id = ${currentRevisionId}
      `.execute(db);

      await expect(
        createProcurementDraft(db, context, input())
      ).rejects.toThrow("unreleased engineering change order");
      expect(await count("purchaseOrder")).toBe(0);
      expect(await count("knowledgeCommandReceipt")).toBe(0);
    });

    it("converges concurrent retries to one receipt and purchase order", async () => {
      const [first, second] = await Promise.all([
        createProcurementDraft(db, context, input()),
        createProcurementDraft(db, context, input())
      ]);

      expect(
        new Set([first.purchaseOrderId, second.purchaseOrderId]).size
      ).toBe(1);
      expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
      expect(await count("purchaseOrder")).toBe(1);
      expect(await count("knowledgeCommandReceipt")).toBe(1);
    });

    it("rejects a reused idempotency key with a changed payload", async () => {
      await createProcurementDraft(db, context, input());
      await expect(
        createProcurementDraft(
          db,
          context,
          input({ payloadHash: "b".repeat(64) })
        )
      ).rejects.toThrow("Idempotency key was reused with a different payload");
      expect(await count("purchaseOrder")).toBe(1);
      expect(await count("knowledgeCommandReceipt")).toBe(1);
    });
  }
);
