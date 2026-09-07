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
  registerMercuryInvoiceSources,
  runInvoiceIntakeBackfillPage
} from "./backfill";
import { registerInvoiceSource } from "./ingestion";

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
        .deleteFrom("documentExtraction")
        .where("companyId", "=", companyId)
        .execute();
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
  it("defers overlapping Gmail candidates without changing the saved payment evidence", async () =>
    fixture(async (c, files) => {
      const records: { id: string }[] = [];
      for (const payment of ["first", "second"]) {
        const attachments = ["shared-a", "shared-b", `${payment}-only`].map(
          (content) => {
            const path = `${c.companyId}/mercury/${payment}/${content}.pdf`;
            files.set(path, new TextEncoder().encode(`%PDF-1.4 ${content}`));
            return { path, source: "gmail", fileName: `${content}.pdf` };
          }
        );
        records.push(...(await imports(c, 1, attachments)));
      }
      await controlInvoiceIntakeBackfill(db, c, "start");
      expect(await runInvoiceIntakeBackfillPage(c)).toMatchObject({
        state: "Completed",
        processed: 2
      });
      expect((await settings(c)).backfillCounts).toMatchObject({
        processed: 2,
        documents: 0,
        needsDocument: 2
      });
      const intakes = await db
        .selectFrom("invoiceIntake")
        .select(["id", "status"])
        .where("companyId", "=", c.companyId)
        .execute();
      const sources = await db
        .selectFrom("invoiceIntakeSource")
        .select(["intakeId", "mercuryImportId", "sha256"])
        .where("companyId", "=", c.companyId)
        .execute();
      expect(intakes).toHaveLength(2);
      expect(sources).toHaveLength(2);
      for (const intake of intakes) {
        expect(intake.status).toBe("NeedsDocument");
        const owned = sources.filter((source) => source.intakeId === intake.id);
        expect(owned).toHaveLength(1);
        expect(
          new Set(owned.map((source) => source.mercuryImportId)).size
        ).toBe(1);
        expect(
          new Set(
            owned.flatMap((source) => (source.sha256 ? [source.sha256] : []))
          ).size
        ).toBe(0);
      }
      expect(new Set(sources.map((source) => source.mercuryImportId))).toEqual(
        new Set(records.map((record) => record.id))
      );
      expect(
        await db
          .selectFrom("mercuryTransactionImport")
          .select("attachments")
          .where("companyId", "=", c.companyId)
          .execute()
      ).toEqual([
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ source: "gmail" })
          ])
        }),
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({ source: "gmail" })
          ])
        })
      ]);
    }));
  it("deduplicates one verified file even when each payment saved it through two channels", async () =>
    fixture(async (c, files) => {
      const bytes = new TextEncoder().encode("%PDF-1.4 Shared invoice bytes");
      const results: Awaited<
        ReturnType<typeof registerMercuryInvoiceSources>
      >[] = [];
      for (const payment of ["first", "second"]) {
        const attachments = ["mercury", "gmail"].map((source) => {
          const path = `${c.companyId}/mercury/${payment}/${source}.pdf`;
          files.set(path, bytes);
          return { path, source, fileName: "invoice.pdf" };
        });
        const [record] = await imports(c, 1, attachments);
        results.push(await registerMercuryInvoiceSources(c, record!.id));
      }
      expect(results[0]!.intakeId).toBe(results[1]!.intakeId);
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .select("id")
          .where("companyId", "=", c.companyId)
          .execute()
      ).toHaveLength(4);
      expect(
        await db
          .selectFrom("invoiceIntake")
          .select("id")
          .where("companyId", "=", c.companyId)
          .execute()
      ).toHaveLength(1);
    }));
  it("refuses foreign-company paths before the collector preflight reads storage", async () =>
    fixture(async (c) => {
      const download = vi.fn();
      const storage = {
        from: () => ({ download })
      } as unknown as Context["storage"];
      await imports(c, 1, [
        {
          path: "another-company/mercury/payment/invoice.pdf",
          source: "mercury",
          fileName: "invoice.pdf"
        }
      ]);
      await controlInvoiceIntakeBackfill(db, c, "start");
      expect(
        (await runInvoiceIntakeBackfillPage({ ...c, storage })).state
      ).toBe("Failed");
      expect((await settings(c)).lastErrorCode).toBe(
        "invoice_source_attachment_unavailable"
      );
      expect(download).not.toHaveBeenCalled();
      expect((await settings(c)).backfillCursor).toBeNull();
    }));
  it("retries a changed attachment snapshot without consolidating from stale file hashes", async () =>
    fixture(async (c, files) => {
      const path = `${c.companyId}/mercury/payment/invoice.pdf`;
      const addedPath = `${c.companyId}/mercury/payment/added.pdf`;
      const first = { path, source: "mercury", fileName: "invoice.pdf" };
      const added = {
        path: addedPath,
        source: "mercury",
        fileName: "added.pdf"
      };
      const [record] = await imports(c, 1, [first]);
      files.set(path, new TextEncoder().encode("%PDF-1.4 First invoice"));
      files.set(addedPath, new TextEncoder().encode("%PDF-1.4 Added invoice"));
      const original = c.storage.from("private");
      let changed = false;
      const storage = {
        from: () => ({
          download: async (savedPath: string) => {
            if (!changed) {
              changed = true;
              await db
                .updateTable("mercuryTransactionImport")
                .set({ attachments: JSON.stringify([first, added]) })
                .where("companyId", "=", c.companyId)
                .where("id", "=", record!.id)
                .execute();
            }
            return original.download(savedPath);
          }
        })
      } as unknown as Context["storage"];
      await controlInvoiceIntakeBackfill(db, c, "start");
      expect(
        (await runInvoiceIntakeBackfillPage({ ...c, storage })).state
      ).toBe("Failed");
      expect((await settings(c)).lastErrorCode).toBe("invoice_source_changed");
      expect((await settings(c)).backfillCursor).toBeNull();
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .select("sha256")
          .where("companyId", "=", c.companyId)
          .execute()
      ).toEqual([{ sha256: null }]);
      await controlInvoiceIntakeBackfill(db, c, "resume");
      expect((await runInvoiceIntakeBackfillPage(c)).state).toBe("Completed");
      expect(
        (
          await db
            .selectFrom("invoiceIntake")
            .select("status")
            .where("companyId", "=", c.companyId)
            .executeTakeFirstOrThrow()
        ).status
      ).toBe("NeedsReview");
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .select("id")
          .where("companyId", "=", c.companyId)
          .execute()
      ).toHaveLength(3);
    }));
  it.each([
    false,
    true
  ])("joins identical documents from installment payments without losing review (existing placeholder: %s)", async (existingPlaceholder) =>
    fixture(async (c, files) => {
      const bytes = new TextEncoder().encode(
        "%PDF-1.4 Synthetic installment invoice"
      );
      const firstPath = `${c.companyId}/mercury/first/invoice.pdf`;
      const secondPath = `${c.companyId}/mercury/second/invoice.pdf`;
      files.set(firstPath, bytes);
      files.set(secondPath, bytes);
      const [first] = await imports(c, 1, [
        { path: firstPath, source: "mercury", fileName: "invoice.pdf" }
      ]);
      const [second] = await imports(c, 1, [
        { path: secondPath, source: "mercury", fileName: "invoice.pdf" }
      ]);
      const canonical = await registerMercuryInvoiceSources(c, first!.id);
      const header = { invoiceNumber: "REVIEWED-INSTALLMENT" };
      const extraction = await db
        .insertInto("documentExtraction")
        .values({
          companyId: c.companyId,
          createdBy: c.userId,
          intakeId: canonical.intakeId,
          documentType: "purchaseInvoice",
          sourceDocument: "invoice.pdf",
          storagePath: firstPath,
          generation: 0,
          inputRevision: 0,
          attemptNumber: 1,
          operation: "extract",
          status: "completed",
          extractedData: JSON.stringify({ immutable: "synthetic evidence" }),
          actualCostUsd: 0.005,
          billingState: "actual"
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const reviewedLine = await db
        .insertInto("invoiceIntakeLine")
        .values({
          companyId: c.companyId,
          createdBy: c.userId,
          intakeId: canonical.intakeId,
          lineKey: "reviewed-line",
          sortOrder: 0,
          description: "Retained human description",
          quantity: 2
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .updateTable("invoiceIntake")
        .set({ status: "NeedsReview", header: JSON.stringify(header) })
        .where("companyId", "=", c.companyId)
        .where("id", "=", canonical.intakeId)
        .execute();
      const placeholder = existingPlaceholder
        ? await registerInvoiceSource(db, c.storage, c, {
            kind: "mercury",
            sourceKey: `payment:${second!.id}`,
            mercuryImportId: second!.id,
            historical: true
          })
        : undefined;
      const previousSources = await db
        .selectFrom("invoiceIntakeSource")
        .selectAll()
        .where("companyId", "=", c.companyId)
        .execute();
      const payments = await db
        .selectFrom("mercuryTransactionImport")
        .select(["id", "reviewStatus", "purchaseInvoiceId"])
        .where("companyId", "=", c.companyId)
        .orderBy("id")
        .execute();
      await controlInvoiceIntakeBackfill(db, c, "start");
      const page = await runInvoiceIntakeBackfillPage(c);
      expect((await settings(c)).lastErrorCode).toBeNull();
      expect(page).toMatchObject({
        state: "Completed",
        processed: 2
      });
      expect((await settings(c)).backfillCounts).toMatchObject({
        processed: 2,
        documents: 2
      });
      const intakes = await db
        .selectFrom("invoiceIntake")
        .select(["id", "status", "header"])
        .where("companyId", "=", c.companyId)
        .execute();
      expect(intakes).toEqual([
        { id: canonical.intakeId, status: "NeedsReview", header }
      ]);
      const sources = await db
        .selectFrom("invoiceIntakeSource")
        .select(["id", "intakeId", "mercuryImportId"])
        .where("companyId", "=", c.companyId)
        .orderBy("id")
        .execute();
      expect(sources).toHaveLength(4);
      expect(new Set(sources.map((source) => source.intakeId))).toEqual(
        new Set([canonical.intakeId])
      );
      expect(new Set(sources.map((source) => source.mercuryImportId))).toEqual(
        new Set([first!.id, second!.id])
      );
      const retainedSources = await db
        .selectFrom("invoiceIntakeSource")
        .selectAll()
        .where("companyId", "=", c.companyId)
        .execute();
      for (const previous of previousSources)
        expect(
          retainedSources.find((source) => source.id === previous.id)
        ).toEqual({
          ...previous,
          intakeId: canonical.intakeId
        });
      expect(
        await db
          .selectFrom("documentExtraction")
          .selectAll()
          .where("companyId", "=", c.companyId)
          .execute()
      ).toEqual([extraction]);
      expect(
        await db
          .selectFrom("invoiceIntakeLine")
          .selectAll()
          .where("companyId", "=", c.companyId)
          .execute()
      ).toEqual([reviewedLine]);
      if (placeholder)
        expect(
          intakes.some((intake) => intake.id === placeholder.intakeId)
        ).toBe(false);
      await controlInvoiceIntakeBackfill(db, c, "start");
      expect((await runInvoiceIntakeBackfillPage(c)).state).toBe("Completed");
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .select(["id", "intakeId", "mercuryImportId"])
          .where("companyId", "=", c.companyId)
          .orderBy("id")
          .execute()
      ).toEqual(sources);
      expect(
        await db
          .selectFrom("mercuryTransactionImport")
          .select(["id", "reviewStatus", "purchaseInvoiceId"])
          .where("companyId", "=", c.companyId)
          .orderBy("id")
          .execute()
      ).toEqual(payments);
    }));
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
