import { randomUUID } from "node:crypto";
import {
  getPostgresConnectionPool,
  type KyselyDatabase
} from "@carbon/database/client";
import { approveMercuryImport } from "@carbon/database/mercury";
import { Kysely, PostgresDialect } from "kysely";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { saveMercurySettings } from "./mercury.server";

// Opt in against an isolated local database with the repository migrations.
const databaseUrl = process.env.PAYMENT_SYNC_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("Mercury approval transactions", () => {
  let db: Kysely<KyselyDatabase>;
  let pool: ReturnType<typeof getPostgresConnectionPool>;
  let actor: string;
  let companyId: string;
  let companies: string[];

  beforeAll(() => {
    if (
      !databaseUrl ||
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(databaseUrl).hostname
      )
    ) {
      throw new Error(
        "Approval integration tests require an explicitly configured local database"
      );
    }
    process.env.SUPABASE_DB_URL = databaseUrl;
    pool = getPostgresConnectionPool(7);
    db = new Kysely<KyselyDatabase>({ dialect: new PostgresDialect({ pool }) });
  });

  async function createCompany() {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO public.company(name,"baseCurrencyCode") VALUES ('Approval Test','USD') RETURNING id`
    );
    const id = rows[0]!.id;
    companies.push(id);
    await pool.query(
      `INSERT INTO public.sequence("table",name,prefix,next,step,size,"companyId") VALUES
      ('supplier','Supplier','SUP-',0,1,4,$1), ('purchaseInvoice','Invoice','PINV-',0,1,4,$1)`,
      [id]
    );
    return id;
  }

  beforeEach(async () => {
    companies = [];
    actor = randomUUID();
    await pool.query(`INSERT INTO public."user"(id,email) VALUES ($1,$2)`, [
      actor,
      `${actor}@example.com`
    ]);
    await pool.query(
      `INSERT INTO public."currencyCode"(code,name) VALUES ('USD','US Dollar') ON CONFLICT DO NOTHING`
    );
    companyId = await createCompany();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.query(
      `DELETE FROM public."mercuryTransactionImport" WHERE "companyId" = ANY($1::TEXT[])`,
      [companies]
    );
    await pool.query(
      `DELETE FROM public."mercuryRecipientMapping" WHERE "companyId" = ANY($1::TEXT[])`,
      [companies]
    );
    await pool.query(`DELETE FROM public.company WHERE id = ANY($1::TEXT[])`, [
      companies
    ]);
    await pool.query(`DELETE FROM public."user" WHERE id = $1`, [actor]);
  });
  afterAll(async () => {
    if (db) await db.destroy();
  });

  async function createImport(
    transactionId: string,
    currencyCode = "USD",
    ownerCompany = companyId
  ) {
    return db
      .insertInto("mercuryTransactionImport")
      .values({
        companyId: ownerCompany,
        mercuryTransactionId: transactionId,
        mercuryAccountId: "account-example",
        mercuryRecipientId: "recipient-example",
        remoteStatus: "sent",
        amount: 123.45,
        currencyCode,
        transactionDate: "2026-09-01",
        createdBy: actor
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  it("creates real supplier children and one draft invoice, then safely repeats", async () => {
    const record = await createImport("transaction-a");
    const input = {
      companyId,
      userId: actor,
      importId: record.id,
      supplierName: "Synthetic Vendor",
      supplierEmail: "billing@vendor.example.com"
    };
    const result = await approveMercuryImport(db, input);
    expect(await approveMercuryImport(db, input)).toMatchObject({
      invoiceId: result.invoiceId
    });
    const invoices = await db
      .selectFrom("purchaseInvoice")
      .selectAll()
      .where("companyId", "=", companyId)
      .execute();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      status: "Draft",
      dateIssued: null,
      postingDate: null,
      datePaid: null,
      totalAmount: 0
    });
    for (const table of [
      "supplier",
      "supplierPayment",
      "supplierShipping",
      "supplierTax",
      "supplierContact",
      "purchaseInvoiceDelivery"
    ] as const) {
      expect(
        await db
          .selectFrom(table)
          .selectAll()
          .where("companyId", "=", companyId)
          .execute()
      ).toHaveLength(1);
    }
    const imported = await db
      .selectFrom("mercuryTransactionImport")
      .selectAll()
      .where("companyId", "=", companyId)
      .executeTakeFirstOrThrow();
    expect(imported.reviewStatus).toBe("Imported");
    expect(imported.purchaseInvoiceId).toBe(result.invoiceId);
    expect(
      await db
        .selectFrom("payment")
        .select("id")
        .where("companyId", "=", companyId)
        .execute()
    ).toHaveLength(0);
  });

  it("serializes different payments to the same recipient without duplicate suppliers", async () => {
    const first = await createImport("transaction-a");
    const second = await createImport("transaction-b");
    const results = await Promise.all(
      [first, second].map((record) =>
        approveMercuryImport(db, {
          companyId,
          userId: actor,
          importId: record.id,
          supplierName: "Synthetic Vendor"
        })
      )
    );
    expect(new Set(results.map(({ invoiceId }) => invoiceId)).size).toBe(2);
    expect(
      await db
        .selectFrom("supplier")
        .select("id")
        .where("companyId", "=", companyId)
        .execute()
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom("mercuryRecipientMapping")
        .select("id")
        .where("companyId", "=", companyId)
        .execute()
    ).toHaveLength(1);
  });

  it("rejects an existing supplier from another company before writing a draft", async () => {
    const otherCompany = await createCompany();
    const supplier = await db
      .insertInto("supplier")
      .values({
        companyId: otherCompany,
        name: "Other Company Vendor",
        createdBy: actor
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const record = await createImport("transaction-a");
    await expect(
      approveMercuryImport(db, {
        companyId,
        userId: actor,
        importId: record.id,
        supplierId: supplier.id
      })
    ).rejects.toThrow("Supplier not found in this company");
    expect(
      await db
        .selectFrom("purchaseInvoice")
        .select("id")
        .where("companyId", "=", companyId)
        .execute()
    ).toHaveLength(0);
  });

  it("rolls back supplier, mapping and interaction if invoice allocation fails", async () => {
    const record = await createImport("transaction-a");
    await db
      .deleteFrom("sequence")
      .where("companyId", "=", companyId)
      .where("table", "=", "purchaseInvoice")
      .execute();
    await expect(
      approveMercuryImport(db, {
        companyId,
        userId: actor,
        importId: record.id,
        supplierName: "Synthetic Vendor"
      })
    ).rejects.toThrow();
    for (const table of [
      "supplier",
      "mercuryRecipientMapping",
      "supplierInteraction",
      "purchaseInvoice"
    ] as const) {
      expect(
        await db
          .selectFrom(table)
          .selectAll()
          .where("companyId", "=", companyId)
          .execute()
      ).toHaveLength(0);
    }
    expect(
      await db
        .selectFrom("mercuryTransactionImport")
        .select("reviewStatus")
        .where("companyId", "=", companyId)
        .executeTakeFirstOrThrow()
    ).toEqual({ reviewStatus: "Pending" });
  });

  it("does not invent an exchange rate for a foreign-currency import", async () => {
    const record = await createImport("transaction-a", "EUR");
    await expect(
      approveMercuryImport(db, {
        companyId,
        userId: actor,
        importId: record.id,
        supplierName: "Synthetic Vendor"
      })
    ).rejects.toThrow("verified exchange rate");
    expect(
      await db
        .selectFrom("supplier")
        .select("id")
        .where("companyId", "=", companyId)
        .execute()
    ).toHaveLength(0);
  });

  it("links another payment to the original invoice without a duplicate draft", async () => {
    const first = await createImport("transaction-a");
    const invoice = await approveMercuryImport(db, {
      companyId,
      userId: actor,
      importId: first.id,
      supplierName: "Synthetic Vendor"
    });
    const second = await createImport("transaction-b");
    const linked = await approveMercuryImport(db, {
      companyId,
      userId: actor,
      importId: second.id,
      purchaseInvoiceId: invoice.invoiceId
    });
    expect(linked.invoiceId).toBe(invoice.invoiceId);
    expect(linked.interactionId).toBe(invoice.interactionId);
    expect(
      await db
        .selectFrom("purchaseInvoice")
        .select("id")
        .where("companyId", "=", companyId)
        .execute()
    ).toHaveLength(1);
    const rows = await db
      .selectFrom("mercuryTransactionImport")
      .select(["purchaseInvoiceId", "reviewStatus"])
      .where("companyId", "=", companyId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.purchaseInvoiceId === invoice.invoiceId &&
          row.reviewStatus === "Imported"
      )
    ).toBe(true);
  });

  it("rejects a requested invoice from another company", async () => {
    const otherCompany = await createCompany();
    const foreign = await createImport(
      "foreign-transaction",
      "USD",
      otherCompany
    );
    const invoice = await approveMercuryImport(db, {
      companyId: otherCompany,
      userId: actor,
      importId: foreign.id,
      supplierName: "Foreign Vendor"
    });
    const local = await createImport("local-transaction");
    await expect(
      approveMercuryImport(db, {
        companyId,
        userId: actor,
        importId: local.id,
        purchaseInvoiceId: invoice.invoiceId
      })
    ).rejects.toThrow("Invoice not found in this company");
    expect(
      await db
        .selectFrom("purchaseInvoice")
        .select("id")
        .where("companyId", "=", companyId)
        .execute()
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom("mercuryTransactionImport")
        .select("reviewStatus")
        .where("id", "=", local.id)
        .executeTakeFirstOrThrow()
    ).toEqual({ reviewStatus: "Pending" });
  });

  it("saves runtime pause controls without losing history and resets cursors only for a changed history range", async () => {
    vi.stubEnv("PAYMENT_SYNC_COMPANY_ID", "");
    vi.stubEnv("MERCURY_API_TOKEN", "");
    const flags = { enabled: false, gmailEnabled: true, disabledMailboxes: [] };
    await saveMercurySettings(db, companyId, actor, flags);
    await db
      .updateTable("mercurySyncSettings")
      .set({ cursor: "payment-checkpoint", eventCursor: "event-checkpoint" })
      .where("companyId", "=", companyId)
      .execute();
    await saveMercurySettings(db, companyId, actor, {
      ...flags,
      gmailEnabled: false
    });
    expect(
      await db
        .selectFrom("mercurySyncSettings")
        .select(["enabled", "gmailEnabled", "cursor", "eventCursor"])
        .where("companyId", "=", companyId)
        .executeTakeFirstOrThrow()
    ).toEqual({
      enabled: false,
      gmailEnabled: false,
      cursor: "payment-checkpoint",
      eventCursor: "event-checkpoint"
    });
    await expect(
      saveMercurySettings(db, companyId, actor, { ...flags, enabled: true })
    ).rejects.toThrow("Configure the Mercury connection");
    await saveMercurySettings(db, companyId, actor, {
      ...flags,
      syncFromDate: "2026-01-01"
    });
    expect(
      await db
        .selectFrom("mercurySyncSettings")
        .select(["cursor", "eventCursor"])
        .where("companyId", "=", companyId)
        .executeTakeFirstOrThrow()
    ).toEqual({ cursor: null, eventCursor: null });
  });
});
