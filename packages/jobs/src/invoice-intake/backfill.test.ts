import { randomUUID } from "node:crypto";
import type { KyselyDatabase } from "@carbon/database/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getGroupId,
  groups
} from "../../../database/supabase/functions/lib/seed.data";
import {
  controlInvoiceIntakeBackfill,
  reconcileMercuryInvoiceSources,
  runInvoiceIntakeBackfillPage
} from "./backfill";

const url = process.env.INVOICE_INTAKE_TEST_DATABASE_URL;
type Context = Parameters<typeof runInvoiceIntakeBackfillPage>[0];
let db: Kysely<KyselyDatabase>;
beforeAll(() => {
  if (
    !url ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
  )
    throw new Error(
      "Set INVOICE_INTAKE_TEST_DATABASE_URL to an isolated local database"
    );
  db = new Kysely<KyselyDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: url,
        max: 6,
        options:
          "-c app.sync_in_progress=true -c storage.allow_delete_query=true"
      })
    })
  });
});
afterAll(async () => {
  await db?.destroy();
});
async function fixture(
  run: (context: Context, files: Map<string, Uint8Array>) => Promise<void>
) {
  const userId = randomUUID();
  let companyId: string | undefined;
  try {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.com` })
      .execute();
    const company = await db
      .insertInto("company")
      .values({ name: "Invoice Backfill Fixture", baseCurrencyCode: "USD" })
      .returning("id")
      .executeTakeFirstOrThrow();
    companyId = company.id;
    await db
      .insertInto("group")
      .values(
        groups.map((group) => ({
          id: getGroupId(group.idPrefix, company.id),
          name: group.name,
          companyId: company.id,
          isCustomerTypeGroup: group.isCustomerTypeGroup,
          isEmployeeTypeGroup: group.isEmployeeTypeGroup,
          isSupplierTypeGroup: group.isSupplierTypeGroup
        }))
      )
      .execute();
    const type = await db
      .insertInto("employeeType")
      .values({ name: "Backfill Operator", companyId })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("employee")
      .values({ id: userId, companyId, employeeTypeId: type.id, active: true })
      .execute();
    await db
      .insertInto("userToCompany")
      .values({ userId, companyId, role: "employee" })
      .onConflict((oc) =>
        oc.columns(["userId", "companyId"]).doUpdateSet({ role: "employee" })
      )
      .execute();
    const permissions = {
      invoicing_view: [companyId],
      invoicing_create: [companyId],
      settings_update: [companyId]
    };
    await db
      .insertInto("userPermission")
      .values({ id: userId, permissions })
      .onConflict((oc) => oc.column("id").doUpdateSet({ permissions }))
      .execute();
    const files = new Map<string, Uint8Array>();
    const storage = {
      from: () => ({
        download: vi.fn(async (path: string) => {
          const bytes = files.get(path);
          return bytes
            ? { data: new Blob([Buffer.from(bytes)]), error: null }
            : { data: null, error: { message: "missing" } };
        })
      })
    } as unknown as Context["storage"];
    await run({ db, storage, companyId, userId }, files);
  } finally {
    if (companyId) {
      await db
        .deleteFrom("invoiceIntake")
        .where("companyId", "=", companyId)
        .execute();
      await db
        .deleteFrom("mercuryTransactionImport")
        .where("companyId", "=", companyId)
        .execute();
      await db.deleteFrom("company").where("id", "=", companyId).execute();
      await sql`DELETE FROM storage.buckets WHERE id=${companyId}`.execute(db);
    }
    await db.deleteFrom("user").where("id", "=", userId).execute();
  }
}
async function imports(c: Context, count = 1, attachments: unknown[] = []) {
  return db
    .insertInto("mercuryTransactionImport")
    .values(
      Array.from({ length: count }, () => ({
        companyId: c.companyId,
        createdBy: c.userId,
        mercuryAccountId: "synthetic-account",
        mercuryTransactionId: randomUUID(),
        transactionDate: "2026-09-01T12:00:00Z",
        remoteStatus: "sent",
        amount: 12,
        currencyCode: "USD",
        attachments: JSON.stringify(attachments)
      }))
    )
    .returning("id")
    .execute();
}
const settings = (c: Context) =>
  db
    .selectFrom("invoiceIntakeSettings")
    .selectAll()
    .where("companyId", "=", c.companyId)
    .executeTakeFirstOrThrow();

describe("resumable historical invoice bridge", () => {
  it("freezes the history window, pages 100 and resumes without duplicating identities", async () =>
    fixture(async (c) => {
      await imports(c, 101);
      await controlInvoiceIntakeBackfill(db, c, "start");
      expect(await runInvoiceIntakeBackfillPage(c)).toMatchObject({
        processed: 100,
        needsMore: true
      });
      await imports(c, 1); // A later payment belongs to the next explicit run/hourly sync.
      await controlInvoiceIntakeBackfill(db, c, "pause");
      expect((await runInvoiceIntakeBackfillPage(c)).state).toBe("paused");
      await controlInvoiceIntakeBackfill(db, c, "resume");
      expect(await runInvoiceIntakeBackfillPage(c)).toMatchObject({
        processed: 1,
        state: "Completed"
      });
      expect((await settings(c)).backfillCounts).toMatchObject({
        processed: 101,
        needsDocument: 101
      });
      await controlInvoiceIntakeBackfill(db, c, "start");
      await runInvoiceIntakeBackfillPage(c);
      await runInvoiceIntakeBackfillPage(c);
      expect(
        await db
          .selectFrom("invoiceIntake")
          .select("id")
          .where("companyId", "=", c.companyId)
          .execute()
      ).toHaveLength(102);
    }));
  it("retains a failed row cursor and safely retries a partially registered source", async () =>
    fixture(async (c, files) => {
      const path = `${c.companyId}/mercury/payment/source.pdf`;
      await imports(c, 1, [
        { path, source: "mercury", fileName: "source.pdf" }
      ]);
      await controlInvoiceIntakeBackfill(db, c, "start");
      expect((await runInvoiceIntakeBackfillPage(c)).state).toBe("Failed");
      expect((await settings(c)).backfillCursor).toBeNull();
      files.set(
        path,
        new TextEncoder().encode("%PDF-1.4 Synthetic historical invoice")
      );
      await controlInvoiceIntakeBackfill(db, c, "resume");
      expect((await runInvoiceIntakeBackfillPage(c)).state).toBe("Completed");
      expect((await settings(c)).backfillCounts).toMatchObject({
        processed: 1,
        documents: 1
      });
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .select("id")
          .where("companyId", "=", c.companyId)
          .execute()
      ).toHaveLength(2);
    }));
  it("recovers failed automatic attachments even when a payment-only bridge already exists", async () =>
    fixture(async (c, files) => {
      await db
        .insertInto("invoiceIntakeSettings")
        .values({ companyId: c.companyId, createdBy: c.userId })
        .execute();
      const path = `${c.companyId}/mercury/payment/source.pdf`;
      await imports(c, 1, [
        { path, source: "mercury", fileName: "source.pdf" }
      ]);
      expect((await reconcileMercuryInvoiceSources(c)).processed).toBe(1);
      files.set(
        path,
        new TextEncoder().encode("%PDF-1.4 Synthetic retry invoice")
      );
      expect((await reconcileMercuryInvoiceSources(c)).processed).toBe(1);
      expect((await reconcileMercuryInvoiceSources(c)).processed).toBe(0);
      expect(
        (
          await db
            .selectFrom("invoiceIntake")
            .select("status")
            .where("companyId", "=", c.companyId)
            .executeTakeFirstOrThrow()
        ).status
      ).toBe("Queued");
    }));
  it("does not search untouched history automatically or run events from a superseded actor", async () =>
    fixture(async (c) => {
      await imports(c, 1);
      await db
        .insertInto("invoiceIntakeSettings")
        .values({ companyId: c.companyId, createdBy: c.userId })
        .execute();
      expect((await reconcileMercuryInvoiceSources(c)).processed).toBe(0);
      await controlInvoiceIntakeBackfill(db, c, "pause");
      await controlInvoiceIntakeBackfill(db, c, "start");
      expect(
        (await runInvoiceIntakeBackfillPage({ ...c, userId: randomUUID() }))
          .state
      ).toBe("stale");
      await db
        .updateTable("employee")
        .set({ active: false })
        .where("companyId", "=", c.companyId)
        .where("id", "=", c.userId)
        .execute();
      expect((await runInvoiceIntakeBackfillPage(c)).state).toBe("Failed");
      expect(
        await db
          .selectFrom("invoiceIntake")
          .select("id")
          .where("companyId", "=", c.companyId)
          .execute()
      ).toHaveLength(0);
    }));
});
