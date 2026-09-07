import { randomUUID } from "node:crypto";
import type { KyselyDatabase } from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
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
import {
  getGroupId,
  groups
} from "../../../database/supabase/functions/lib/seed.data";
import type { InvoiceCandidate } from "./matching";
import {
  GmailClient,
  type GmailMailboxConfig,
  MercuryClient,
  type PaymentSource,
  ProviderError
} from "./providers";
import { refreshMercurySupportingDocuments, runMercurySync } from "./sync";

// Opt in only against an isolated local database with the repository migrations.
// Credentials are supplied by the caller, never a committed configuration file.
const databaseUrl = process.env.PAYMENT_SYNC_TEST_DATABASE_URL;
type Context = Parameters<typeof runMercurySync>[0];
const bytes = new TextEncoder().encode("%PDF-1.4\nSynthetic invoice fixture");
const mailboxConfig: GmailMailboxConfig = {
  email: "invoices@example.com",
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  refreshToken: "synthetic-refresh",
  enabled: true
};

function payment(overrides: Partial<PaymentSource> = {}): PaymentSource {
  return {
    id: "transaction-example",
    accountId: "account-example",
    recipientId: "recipient-example",
    name: "Synthetic Vendor",
    email: "billing@vendor.example.com",
    amount: "-123.45",
    currency: "USD",
    status: "sent",
    kind: "outgoingPayment",
    postedAt: "2026-09-01T12:00:00Z",
    createdAt: "2026-09-01T11:00:00Z",
    note: "Invoice TEST-1001",
    attachments: [],
    ...overrides
  };
}

function candidate(): InvoiceCandidate {
  return {
    mailbox: mailboxConfig.email,
    messageId: "message-example",
    subject: "Invoice TEST-1001",
    from: "Synthetic Vendor <billing@vendor.example.com>",
    date: "2026-09-01T00:00:00Z",
    text: "Invoice TEST-1001 from Synthetic Vendor. Total USD 123.45.",
    score: 0,
    reasons: [],
    suggestedVendor: {
      name: "Synthetic Vendor",
      email: "billing@vendor.example.com"
    },
    attachments: [
      {
        id: "attachment-example",
        fileName: "invoice.pdf",
        mimeType: "application/pdf",
        size: bytes.length
      }
    ]
  };
}

describe.skipIf(!databaseUrl)("Mercury sync against PostgreSQL", () => {
  let db: Kysely<KyselyDatabase>;
  let pool: pg.Pool;
  let companyId: string;
  let actor: string;
  let companies: string[];
  let mercury: MercuryClient;
  let gmail: GmailClient;
  let upload: ReturnType<typeof vi.fn>;
  let context: Context;

  beforeAll(() => {
    if (
      !databaseUrl ||
      !["127.0.0.1", "localhost", "[::1]"].includes(
        new URL(databaseUrl).hostname
      )
    ) {
      throw new Error(
        "Payment integration tests require an explicitly configured local database"
      );
    }
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 5,
      options: "-c app.sync_in_progress=true -c storage.allow_delete_query=true"
    });
    db = new Kysely<KyselyDatabase>({ dialect: new PostgresDialect({ pool }) });
  });

  async function createCompany(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO public.company(name,"baseCurrencyCode") VALUES ('Payment Worker Test','USD') RETURNING id`
    );
    const id = rows[0]!.id;
    companies.push(id);
    await db
      .insertInto("group")
      .values(
        groups.map((group) => ({
          id: getGroupId(group.idPrefix, id),
          name: group.name,
          companyId: id,
          isCustomerTypeGroup: group.isCustomerTypeGroup,
          isEmployeeTypeGroup: group.isEmployeeTypeGroup,
          isSupplierTypeGroup: group.isSupplierTypeGroup
        }))
      )
      .execute();
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
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO public."employeeType"(name,"companyId") VALUES ('Test Operator',$1) RETURNING id`,
      [companyId]
    );
    await pool.query(
      `INSERT INTO public.employee(id,"companyId","employeeTypeId",active) VALUES ($1,$2,$3,TRUE)`,
      [actor, companyId, rows[0]!.id]
    );
    await db
      .insertInto("userToCompany")
      .values({ userId: actor, companyId, role: "employee" })
      .onConflict((conflict) =>
        conflict
          .columns(["userId", "companyId"])
          .doUpdateSet({ role: "employee" })
      )
      .execute();
    await db
      .insertInto("userPermission")
      .values({ id: actor, permissions: { invoicing_view: [companyId] } })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          permissions: { invoicing_view: [companyId] }
        })
      )
      .execute();
    await pool.query(
      `INSERT INTO public."mercurySyncSettings"("companyId","createdBy",enabled) VALUES ($1,$2,TRUE)`,
      [companyId, actor]
    );

    mercury = new MercuryClient("synthetic-test-token", {
      fetch: vi.fn().mockRejectedValue(new Error("Unexpected network request"))
    });
    vi.spyOn(mercury, "listTransactions").mockResolvedValue({
      payments: [payment()],
      nextPage: null
    });
    vi.spyOn(mercury, "listEvents").mockResolvedValue({
      events: [],
      nextPage: null
    });
    vi.spyOn(mercury, "getTransaction").mockResolvedValue(payment());
    vi.spyOn(mercury, "getRecipient").mockResolvedValue({
      id: "recipient-example",
      name: "Synthetic Vendor",
      email: "billing@vendor.example.com",
      emails: []
    });
    vi.spyOn(mercury, "downloadAttachment").mockResolvedValue(bytes);
    gmail = new GmailClient(mailboxConfig, {
      fetch: vi.fn().mockRejectedValue(new Error("Unexpected network request"))
    });
    vi.spyOn(gmail, "searchInvoices").mockResolvedValue({
      candidates: [candidate()],
      truncated: false
    });
    vi.spyOn(gmail, "getAttachment").mockResolvedValue(bytes);
    upload = vi.fn().mockResolvedValue({ error: null });
    context = {
      db,
      companyId,
      mercury,
      mailboxes: [],
      gmailClients: [],
      storage: { from: () => ({ upload }) } as unknown as Context["storage"]
    };
  });

  afterEach(async () => {
    // All fixture records are scoped by generated company/user IDs.
    await db
      .deleteFrom("invoiceIntake")
      .where("companyId", "in", companies)
      .execute();
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
    await pool.query(`DELETE FROM storage.buckets WHERE id = ANY($1::TEXT[])`, [
      companies
    ]);
    await pool.query(`DELETE FROM public."user" WHERE id = $1`, [actor]);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (db) await db.destroy();
  });

  async function state() {
    return db
      .selectFrom("mercurySyncSettings")
      .selectAll()
      .where("companyId", "=", companyId)
      .executeTakeFirstOrThrow();
  }
  async function imports() {
    return db
      .selectFrom("mercuryTransactionImport")
      .selectAll()
      .where("companyId", "=", companyId)
      .execute();
  }

  it("does not contact providers when synchronization is disabled", async () => {
    await db
      .updateTable("mercurySyncSettings")
      .set({ enabled: false })
      .where("companyId", "=", companyId)
      .execute();
    expect(await runMercurySync(context)).toMatchObject({
      state: "disabled",
      imported: 0
    });
    expect(mercury.listTransactions).not.toHaveBeenCalled();
    expect(mercury.listEvents).not.toHaveBeenCalled();
    expect(await imports()).toHaveLength(0);
  });

  it("commits hourly bank evidence even when automatic document registration fails", async () => {
    await db
      .updateTable("userPermission")
      .set({
        permissions: {
          invoicing_view: [companyId],
          invoicing_create: [companyId]
        }
      })
      .where("id", "=", actor)
      .execute();
    await db
      .insertInto("invoiceIntakeSettings")
      .values({ companyId, createdBy: actor, enabled: false })
      .execute();
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [
        payment({
          attachments: [
            {
              id: "receipt",
              fileName: "receipt.pdf",
              url: "https://files.example.com/receipt.pdf"
            }
          ]
        })
      ],
      nextPage: null
    });
    // Upload succeeds but there is deliberately no download method: this is a
    // registration outage after evidence and its bank cursor have committed.
    expect((await runMercurySync(context)).state).toBe("complete");
    expect((await state()).cursor).toBe("transaction-example");
    expect(await imports()).toHaveLength(1);
    const intakeSettings = await db
      .selectFrom("invoiceIntakeSettings")
      .select(["enabled", "lastErrorCode"])
      .where("companyId", "=", companyId)
      .executeTakeFirstOrThrow();
    expect(intakeSettings).toMatchObject({
      enabled: false,
      lastErrorCode: "invoice_automatic_registration_failed"
    });
  });

  it("explicitly searches reviewed payments while preserving review and honoring mailbox pauses", async () => {
    await runMercurySync(context);
    const [record] = await imports();
    await db
      .updateTable("mercuryTransactionImport")
      .set({
        reviewStatus: "Imported",
        vendorSuggestion: { name: "Confirmed Supplier" }
      })
      .where("id", "=", record!.id)
      .execute();
    await db
      .updateTable("userPermission")
      .set({
        permissions: {
          invoicing_view: [companyId],
          invoicing_create: [companyId]
        }
      })
      .where("id", "=", actor)
      .execute();
    context.mailboxes = [mailboxConfig];
    context.gmailClients = [gmail];
    await db
      .updateTable("mercurySyncSettings")
      .set({ gmailEnabled: true })
      .where("companyId", "=", companyId)
      .execute();
    expect(
      (await refreshMercurySupportingDocuments(context, actor, record!.id))
        .state
    ).toBe("complete");
    expect(gmail.searchInvoices).toHaveBeenCalled();
    expect((await imports())[0]).toMatchObject({
      reviewStatus: "Imported",
      vendorSuggestion: { name: "Confirmed Supplier" }
    });
    vi.mocked(gmail.searchInvoices).mockClear();
    await db
      .updateTable("mercurySyncSettings")
      .set({ disabledMailboxes: [mailboxConfig.email] })
      .where("companyId", "=", companyId)
      .execute();
    await refreshMercurySupportingDocuments(context, actor, record!.id);
    expect(gmail.searchInvoices).not.toHaveBeenCalled();
  });

  it.each([
    "inactive employee",
    "inactive user",
    "missing membership",
    "supplier membership",
    "missing permission",
    "another company permission"
  ])("does not run for an operator with %s", async (revocation) => {
    if (revocation === "inactive employee") {
      await db
        .updateTable("employee")
        .set({ active: false })
        .where("id", "=", actor)
        .where("companyId", "=", companyId)
        .execute();
    } else if (revocation === "inactive user") {
      await db
        .updateTable("user")
        .set({ active: false })
        .where("id", "=", actor)
        .execute();
    } else if (revocation === "missing membership") {
      await db
        .deleteFrom("userToCompany")
        .where("userId", "=", actor)
        .where("companyId", "=", companyId)
        .execute();
    } else if (revocation === "supplier membership") {
      await db
        .updateTable("userToCompany")
        .set({ role: "supplier" })
        .where("userId", "=", actor)
        .where("companyId", "=", companyId)
        .execute();
    } else {
      await db
        .updateTable("userPermission")
        .set({
          permissions: {
            invoicing_view:
              revocation === "missing permission" ? [] : ["another-company"]
          }
        })
        .where("id", "=", actor)
        .execute();
    }
    await expect(runMercurySync(context)).rejects.toThrow("sync_failed");
    expect(mercury.listTransactions).not.toHaveBeenCalled();
    expect(mercury.listEvents).not.toHaveBeenCalled();
    expect(await imports()).toHaveLength(0);
    expect((await state()).cursor).toBeNull();
  });

  it("honors the existing all-companies permission only for active employees", async () => {
    await db
      .updateTable("userPermission")
      .set({ permissions: { invoicing_view: ["0"] } })
      .where("id", "=", actor)
      .execute();
    expect(await runMercurySync(context)).toMatchObject({ state: "complete" });
    expect(await imports()).toHaveLength(1);
    await db
      .updateTable("employee")
      .set({ active: false })
      .where("id", "=", actor)
      .where("companyId", "=", companyId)
      .execute();
    vi.mocked(mercury.listTransactions).mockClear();
    await expect(runMercurySync(context)).rejects.toThrow("sync_failed");
    expect(mercury.listTransactions).not.toHaveBeenCalled();
  });

  it("deduplicates repeat imports and persists JSON invoice evidence and attachments", async () => {
    context.mailboxes = [mailboxConfig];
    context.gmailClients = [gmail];
    await runMercurySync(context);
    await runMercurySync(context);
    const rows = await imports();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reviewStatus: "Pending",
      remoteStatus: "sent"
    });
    expect(rows[0]!.attachments).toEqual([
      expect.objectContaining({ source: "gmail", mailbox: mailboxConfig.email })
    ]);
    expect(rows[0]!.invoiceEvidence).toEqual([
      expect.objectContaining({ messageId: "message-example" })
    ]);
    expect(Array.isArray(rows[0]!.attachments)).toBe(true);
    expect((await state()).cursor).toBe("transaction-example");
    expect(new Set(upload.mock.calls.map((call) => call[0])).size).toBe(1);
  });

  it("refreshes failed and reversed payments without creating duplicate drafts", async () => {
    await runMercurySync(context);
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [],
      nextPage: null
    });
    for (const status of ["failed", "reversed"]) {
      vi.mocked(mercury.listEvents).mockResolvedValue({
        events: [
          {
            id: `event-${status}`,
            resourceId: "transaction-example",
            resourceType: "transaction",
            operationType: "update",
            occurredAt: "2026-09-02T00:00:00Z"
          }
        ],
        nextPage: null
      });
      vi.mocked(mercury.getTransaction).mockResolvedValue(payment({ status }));
      await runMercurySync(context);
      expect(await imports()).toEqual([
        expect.objectContaining({
          remoteStatus: status,
          reviewStatus: "Pending"
        })
      ]);
      expect((await state()).eventCursor).toBe(`event-${status}`);
    }
  });

  it("applies the creation-time history boundary to newly discovered event transactions", async () => {
    await db
      .updateTable("mercurySyncSettings")
      .set({ syncFromDate: "2026-09-01" })
      .where("companyId", "=", companyId)
      .execute();
    const changed = [
      payment({ id: "old-payment", createdAt: "2026-08-31T23:59:59Z" }),
      payment({
        id: "offset-before-start",
        createdAt: "2026-09-01T00:30:00+01:00"
      }),
      payment({ id: "at-start", createdAt: "2026-08-31T20:00:00-04:00" })
    ];
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [],
      nextPage: null
    });
    vi.mocked(mercury.listEvents).mockResolvedValue({
      events: changed.map((row) => ({
        id: `event-${row.id}`,
        resourceId: row.id,
        resourceType: "transaction",
        operationType: "update",
        occurredAt: "2026-09-02T00:00:00Z"
      })),
      nextPage: null
    });
    vi.mocked(mercury.getTransaction).mockImplementation(
      async (id) => changed.find((row) => row.id === id)!
    );
    await runMercurySync(context);
    expect(await imports()).toEqual([
      expect.objectContaining({ mercuryTransactionId: "at-start" })
    ]);
    expect((await state()).eventCursor).toBe("event-at-start");
    expect(mercury.listTransactions).toHaveBeenCalledWith({
      start: "2026-09-01",
      startAfter: undefined,
      limit: 25
    });
  });

  it("refreshes already imported payments even when a new history boundary excludes their creation date", async () => {
    const older = payment({
      createdAt: "2020-01-01T00:00:00Z",
      postedAt: "2020-01-02T00:00:00Z"
    });
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [older],
      nextPage: null
    });
    vi.mocked(mercury.getTransaction).mockResolvedValue(older);
    await runMercurySync(context);
    await db
      .updateTable("mercurySyncSettings")
      .set({ syncFromDate: "2026-09-01" })
      .where("companyId", "=", companyId)
      .execute();
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [],
      nextPage: null
    });
    vi.mocked(mercury.listEvents).mockResolvedValue({
      events: [
        {
          id: "event-old-reversal",
          resourceId: older.id,
          resourceType: "transaction",
          operationType: "update",
          occurredAt: "2026-09-02T00:00:00Z"
        }
      ],
      nextPage: null
    });
    vi.mocked(mercury.getTransaction).mockResolvedValue({
      ...older,
      status: "reversed"
    });
    await runMercurySync(context);
    expect(await imports()).toEqual([
      expect.objectContaining({
        mercuryTransactionId: older.id,
        remoteStatus: "reversed"
      })
    ]);
    expect((await state()).eventCursor).toBe("event-old-reversal");
  });

  it("does not advance event history past an invalid new transaction creation date", async () => {
    await db
      .updateTable("mercurySyncSettings")
      .set({ syncFromDate: "2026-09-01" })
      .where("companyId", "=", companyId)
      .execute();
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [],
      nextPage: null
    });
    vi.mocked(mercury.listEvents).mockResolvedValue({
      events: [
        {
          id: "invalid-date-event",
          resourceId: "transaction-example",
          resourceType: "transaction",
          operationType: "update",
          occurredAt: "2026-09-02T00:00:00Z"
        }
      ],
      nextPage: null
    });
    vi.mocked(mercury.getTransaction).mockResolvedValue(
      payment({ createdAt: "invalid" })
    );
    await expect(runMercurySync(context)).rejects.toThrow(
      "mercury_invalid_created_at"
    );
    expect(await imports()).toHaveLength(0);
    expect((await state()).eventCursor).toBeNull();
  });

  it("continues bank import while recording a retryable Gmail failure", async () => {
    context.mailboxes = [mailboxConfig];
    context.gmailClients = [gmail];
    vi.mocked(gmail.searchInvoices).mockRejectedValue(
      new ProviderError("Gmail", "http_error", 401)
    );
    expect(await runMercurySync(context)).toMatchObject({ state: "complete" });
    expect(await imports()).toHaveLength(1);
    expect(await state()).toMatchObject({
      cursor: "transaction-example",
      lastGmailError: "gmail_http_error_401",
      lastError: null
    });
    expect((await state()).lastSuccessAt).not.toBeNull();
  });

  it("does not advance a cursor if its database write fails", async () => {
    // Fault injection past the provider parser exercises the DB transaction.
    const invalid = payment({ currency: null as unknown as string });
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [invalid],
      nextPage: null
    });
    await expect(runMercurySync(context)).rejects.toThrow();
    expect((await state()).cursor).toBeNull();
    expect(await imports()).toHaveLength(0);
  });

  it("honors a disable toggle changed while a remote request is in flight", async () => {
    vi.mocked(mercury.listTransactions).mockImplementation(async () => {
      await db
        .updateTable("mercurySyncSettings")
        .set({ enabled: false })
        .where("companyId", "=", companyId)
        .execute();
      return { payments: [payment()], nextPage: null };
    });
    expect(await runMercurySync(context)).toMatchObject({
      state: "disabled",
      imported: 0
    });
    expect(await imports()).toHaveLength(0);
    expect((await state()).cursor).toBeNull();
  });

  it("stops subsequent event fetches within the pause interval, including injected provider methods", async () => {
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [],
      nextPage: null
    });
    vi.mocked(mercury.listEvents).mockResolvedValue({
      events: ["first", "second", "third"].map((id) => ({
        id: `event-${id}`,
        resourceId: id,
        resourceType: "transaction",
        operationType: "update",
        occurredAt: "2026-09-02T00:00:00Z"
      })),
      nextPage: null
    });
    vi.mocked(mercury.getTransaction).mockImplementation(async (id) => {
      await db
        .updateTable("mercurySyncSettings")
        .set({ enabled: false })
        .where("companyId", "=", companyId)
        .execute();
      clock.mockReturnValue(now + 1001);
      return payment({ id });
    });
    expect(await runMercurySync(context)).toMatchObject({ state: "disabled" });
    expect(mercury.getTransaction).toHaveBeenCalledTimes(1);
    expect(mercury.getTransaction).toHaveBeenCalledWith("first");
    expect(await imports()).toHaveLength(0);
    expect((await state()).eventCursor).toBeNull();
  });

  it("stops subsequent round-robin requests after a pause without applying the unfinished refresh", async () => {
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    await db
      .insertInto("mercuryTransactionImport")
      .values(
        ["first", "second"].map((id) => ({
          companyId,
          createdBy: actor,
          mercuryTransactionId: id,
          mercuryAccountId: "account-example",
          remoteStatus: "sent",
          amount: 123.45,
          currencyCode: "USD",
          transactionDate: "2026-09-01"
        }))
      )
      .execute();
    vi.mocked(mercury.listTransactions).mockResolvedValue({
      payments: [],
      nextPage: null
    });
    vi.mocked(mercury.getTransaction).mockImplementation(async (id) => {
      await db
        .updateTable("mercurySyncSettings")
        .set({ enabled: false })
        .where("companyId", "=", companyId)
        .execute();
      clock.mockReturnValue(now + 1001);
      return payment({ id, status: "reversed" });
    });
    expect(await runMercurySync(context)).toMatchObject({ state: "disabled" });
    expect(mercury.getTransaction).toHaveBeenCalledTimes(1);
    expect(await imports()).toHaveLength(2);
    expect((await imports()).every((row) => row.remoteStatus === "sent")).toBe(
      true
    );
  });

  it("rechecks operator permission after an in-flight provider request before writing evidence", async () => {
    vi.mocked(mercury.listTransactions).mockImplementation(async () => {
      await db
        .updateTable("userPermission")
        .set({ permissions: {} })
        .where("id", "=", actor)
        .execute();
      return { payments: [payment()], nextPage: null };
    });
    await expect(runMercurySync(context)).rejects.toThrow("sync_failed");
    expect(await imports()).toHaveLength(0);
    expect(mercury.getRecipient).not.toHaveBeenCalled();
    expect((await state()).cursor).toBeNull();
  });

  it("retries a page if its history settings change during a remote read", async () => {
    vi.mocked(mercury.listTransactions).mockImplementation(async () => {
      await db
        .updateTable("mercurySyncSettings")
        .set({ syncFromDate: "2026-09-01", updatedAt: sql`clock_timestamp()` })
        .where("companyId", "=", companyId)
        .execute();
      return { payments: [payment()], nextPage: null };
    });
    expect(await runMercurySync(context)).toMatchObject({
      state: "disabled",
      imported: 0
    });
    expect(await imports()).toHaveLength(0);
    expect((await state()).cursor).toBeNull();
  });

  it("does not overlap another sync for the same company", async () => {
    await db.connection().execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(hashtext('mercury-sync'),hashtext(${companyId}))`.execute(
        connection
      );
      try {
        expect(await runMercurySync(context)).toMatchObject({
          state: "busy",
          imported: 0
        });
        expect(mercury.listTransactions).not.toHaveBeenCalled();
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtext('mercury-sync'),hashtext(${companyId}))`.execute(
          connection
        );
      }
    });
  });

  it("leaves another company's settings and payment evidence unchanged", async () => {
    const otherCompany = await createCompany();
    await db
      .insertInto("mercurySyncSettings")
      .values({
        companyId: otherCompany,
        createdBy: actor,
        enabled: false,
        cursor: "other-cursor"
      })
      .execute();
    await db
      .insertInto("mercuryTransactionImport")
      .values({
        companyId: otherCompany,
        createdBy: actor,
        mercuryTransactionId: "transaction-example",
        mercuryAccountId: "other-account",
        remoteStatus: "pending",
        amount: 10,
        currencyCode: "USD",
        transactionDate: "2026-09-01"
      })
      .execute();
    await runMercurySync(context);
    expect(
      await db
        .selectFrom("mercuryTransactionImport")
        .selectAll()
        .where("companyId", "=", otherCompany)
        .execute()
    ).toEqual([
      expect.objectContaining({ remoteStatus: "pending", amount: "10" })
    ]);
    expect(
      await db
        .selectFrom("mercurySyncSettings")
        .selectAll()
        .where("companyId", "=", otherCompany)
        .executeTakeFirstOrThrow()
    ).toMatchObject({ enabled: false, cursor: "other-cursor" });
    expect(await imports()).toHaveLength(1);
  });

  it("honors individual mailbox and Gmail-wide switches", async () => {
    context.mailboxes = [mailboxConfig];
    context.gmailClients = [gmail];
    await db
      .updateTable("mercurySyncSettings")
      .set({ disabledMailboxes: [mailboxConfig.email] })
      .where("companyId", "=", companyId)
      .execute();
    await runMercurySync(context);
    expect(gmail.searchInvoices).not.toHaveBeenCalled();
    await db
      .updateTable("mercurySyncSettings")
      .set({ disabledMailboxes: [], gmailEnabled: false })
      .where("companyId", "=", companyId)
      .execute();
    await runMercurySync(context);
    expect(gmail.searchInvoices).not.toHaveBeenCalled();
  });

  it("keeps the new purchasing mailbox active when an old mailbox is disabled", async () => {
    const purchasingConfig = {
      ...mailboxConfig,
      email: "purchasing@example.com"
    };
    const purchasing = new GmailClient(purchasingConfig, {
      fetch: vi.fn().mockRejectedValue(new Error("Unexpected network request"))
    });
    vi.spyOn(purchasing, "searchInvoices").mockResolvedValue({
      candidates: [],
      truncated: false
    });
    context.mailboxes = [mailboxConfig, purchasingConfig];
    context.gmailClients = [gmail, purchasing];
    await db
      .updateTable("mercurySyncSettings")
      .set({ disabledMailboxes: [mailboxConfig.email] })
      .where("companyId", "=", companyId)
      .execute();
    await runMercurySync(context);
    expect(gmail.searchInvoices).not.toHaveBeenCalled();
    expect(purchasing.searchInvoices).toHaveBeenCalled();
  });

  it("preserves a vendor review completed during remote invoice matching", async () => {
    await runMercurySync(context);
    context.mailboxes = [mailboxConfig];
    context.gmailClients = [gmail];
    const reviewed = {
      name: "Reviewed Synthetic Vendor",
      email: "reviewed@example.com"
    };
    vi.mocked(gmail.searchInvoices).mockImplementation(async () => {
      await db
        .updateTable("mercuryTransactionImport")
        .set({ reviewStatus: "Imported", vendorSuggestion: reviewed })
        .where("companyId", "=", companyId)
        .where("mercuryTransactionId", "=", "transaction-example")
        .execute();
      return { candidates: [candidate()], truncated: false };
    });
    await runMercurySync(context);
    expect((await imports())[0]).toMatchObject({
      reviewStatus: "Imported",
      vendorSuggestion: reviewed
    });
  });
});
