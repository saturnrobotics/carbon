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
import { registerMercuryInvoiceSources } from "./backfill";
import type { InvoiceActor } from "./contracts";
import { INVOICE_LIMITS } from "./contracts";
import {
  isInvoiceSourcePath,
  registerInvoiceSource,
  validateInvoiceSourceBytes
} from "./ingestion";

const databaseUrl = process.env.INVOICE_INTAKE_TEST_DATABASE_URL;
const bytes = new TextEncoder().encode("%PDF-1.4\nSynthetic receipt evidence");
type Storage = Parameters<typeof registerInvoiceSource>[1];

describe("Invoice source boundaries", () => {
  it("sniffs supported bytes and rejects truncated PNG, extension spoofing and oversized files", () => {
    expect(validateInvoiceSourceBytes(bytes).mediaType).toBe("application/pdf");
    expect(() =>
      validateInvoiceSourceBytes(new TextEncoder().encode("invoice.pdf"))
    ).toThrow("invoice_media_unsupported");
    expect(() =>
      validateInvoiceSourceBytes(new Uint8Array([137, 80, 78, 71]))
    ).toThrow("invoice_media_unsupported");
    const large = new Uint8Array(INVOICE_LIMITS.pdfBytes + 1);
    large.set(bytes);
    expect(() => validateInvoiceSourceBytes(large)).toThrow(
      "invoice_source_size_invalid"
    );
  });
  it("accepts only the exact protected company prefix with safe path segments", () => {
    expect(
      isInvoiceSourcePath("company-a", "company-a/invoice-intake/source.pdf")
    ).toBe(true);
    for (const path of [
      "company-b/invoice-intake/source.pdf",
      "company-a/invoice-intake/../source.pdf",
      "company-a/invoice-intake//source.pdf",
      "company-a/invoice-intake/a\\b.pdf"
    ]) {
      expect(isInvoiceSourcePath("company-a", path)).toBe(false);
    }
  });
});

describe.skipIf(!databaseUrl)(
  "Invoice source registration against PostgreSQL",
  () => {
    let db: Kysely<KyselyDatabase>;
    let pool: pg.Pool;
    let actor: InvoiceActor;
    let objects: Map<string, Uint8Array>;
    let upload: ReturnType<typeof vi.fn>;
    let download: ReturnType<typeof vi.fn>;
    let storage: Storage;
    beforeAll(() => {
      if (
        !databaseUrl ||
        !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(databaseUrl).hostname
        )
      ) {
        throw new Error(
          "Invoice integration tests require an explicitly configured local database"
        );
      }
      pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 5,
        options:
          "-c app.sync_in_progress=true -c storage.allow_delete_query=true"
      });
      db = new Kysely<KyselyDatabase>({
        dialect: new PostgresDialect({ pool })
      });
    });
    beforeEach(async () => {
      const userId = randomUUID();
      await db
        .insertInto("user")
        .values({ id: userId, email: `${userId}@example.com` })
        .execute();
      const company = await db
        .insertInto("company")
        .values({ name: "Invoice Source Fixture", baseCurrencyCode: "USD" })
        .returning("id")
        .executeTakeFirstOrThrow();
      actor = { companyId: company.id, userId };
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
        .values({ name: "Invoice Operator", companyId: company.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("employee")
        .values({
          id: userId,
          companyId: company.id,
          employeeTypeId: type.id,
          active: true
        })
        .execute();
      await db
        .insertInto("userToCompany")
        .values({ userId, companyId: company.id, role: "employee" })
        .onConflict((oc) =>
          oc.columns(["userId", "companyId"]).doUpdateSet({ role: "employee" })
        )
        .execute();
      const permissions = {
        invoicing_view: [company.id],
        invoicing_create: [company.id]
      };
      await db
        .insertInto("userPermission")
        .values({ id: userId, permissions })
        .onConflict((oc) => oc.column("id").doUpdateSet({ permissions }))
        .execute();
      objects = new Map();
      upload = vi.fn(async (path: string, content: Uint8Array) => {
        objects.set(path, content);
        return { error: null };
      });
      download = vi.fn(async (path: string) => {
        const content = objects.get(path);
        return content
          ? { data: new Blob([Buffer.from(content)]), error: null }
          : { data: null, error: { message: "missing" } };
      });
      storage = { from: () => ({ upload, download }) } as unknown as Storage;
    });
    afterEach(async () => {
      if (!actor) return;
      await db
        .deleteFrom("documentExtraction")
        .where("companyId", "=", actor.companyId)
        .execute();
      await db
        .deleteFrom("invoiceIntake")
        .where("companyId", "=", actor.companyId)
        .execute();
      await db
        .deleteFrom("mercuryTransactionImport")
        .where("companyId", "=", actor.companyId)
        .execute();
      await db
        .updateTable("purchaseInvoice")
        .set({ status: "Draft" })
        .where("companyId", "=", actor.companyId)
        .execute();
      await db
        .deleteFrom("purchaseInvoice")
        .where("companyId", "=", actor.companyId)
        .execute();
      await db
        .deleteFrom("company")
        .where("id", "=", actor.companyId)
        .execute();
      await pool.query(`DELETE FROM storage.buckets WHERE id=$1`, [
        actor.companyId
      ]);
      await db.deleteFrom("user").where("id", "=", actor.userId).execute();
    });
    afterAll(async () => {
      await db?.destroy();
    });

    const manual = (sourceKey: string) => ({
      kind: "upload" as const,
      sourceKey,
      bytes,
      fileName: "receipt.pdf"
    });
    async function mercury(
      attachments: unknown[] = [],
      reviewStatus = "Pending",
      purchaseInvoiceId?: string
    ) {
      return db
        .insertInto("mercuryTransactionImport")
        .values({
          companyId: actor.companyId,
          createdBy: actor.userId,
          mercuryAccountId: "synthetic-account",
          mercuryTransactionId: randomUUID(),
          transactionDate: "2026-09-01T12:00:00Z",
          remoteStatus: "sent",
          amount: 12,
          currencyCode: "USD",
          attachments: JSON.stringify(attachments),
          reviewStatus,
          purchaseInvoiceId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    }
    async function invoice(status: "Draft" | "Open" = "Draft") {
      const supplier = await db
        .insertInto("supplier")
        .values({
          companyId: actor.companyId,
          createdBy: actor.userId,
          name: `Synthetic Invoice Supplier ${randomUUID()}`,
          readableId: randomUUID()
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const interaction = await db
        .insertInto("supplierInteraction")
        .values({ companyId: actor.companyId, supplierId: supplier.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      return db
        .insertInto("purchaseInvoice")
        .values({
          companyId: actor.companyId,
          createdBy: actor.userId,
          supplierInteractionId: interaction.id,
          invoiceId: randomUUID(),
          currencyCode: "USD",
          status
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    }

    it("serializes equal-byte uploads into one intake while retaining both provenance identities", async () => {
      const [a, b] = await Promise.all([
        registerInvoiceSource(db, storage, actor, manual("a")),
        registerInvoiceSource(db, storage, actor, manual("b"))
      ]);
      expect(a.intakeId).toBe(b.intakeId);
      expect(a.sourceId).not.toBe(b.sourceId);
      expect(
        await db
          .selectFrom("invoiceIntake")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom("purchaseInvoice")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(0);
    });
    it("retries the same identity without mutation and refuses different bytes for it", async () => {
      const first = await registerInvoiceSource(
        db,
        storage,
        actor,
        manual("same")
      );
      const retried = await registerInvoiceSource(
        db,
        storage,
        actor,
        manual("same")
      );
      expect(retried.sourceId).toBe(first.sourceId);
      await expect(
        registerInvoiceSource(db, storage, actor, {
          ...manual("same"),
          bytes: new TextEncoder().encode("%PDF-1.4\nDifferent invoice")
        })
      ).rejects.toThrow("invoice_source_identity_conflict");
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(1);
    });
    it("rejects inactive actors before any privileged file access", async () => {
      await db
        .updateTable("employee")
        .set({ active: false })
        .where("companyId", "=", actor.companyId)
        .where("id", "=", actor.userId)
        .execute();
      await expect(
        registerInvoiceSource(db, storage, actor, manual("a"))
      ).rejects.toThrow("invoice_source_access_denied");
      expect(upload).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    });
    it("rejects obsolete wildcard-only grants before reading or uploading financial sources", async () => {
      await db
        .updateTable("userPermission")
        .set({
          permissions: { invoicing_view: ["0"], invoicing_create: ["0"] }
        })
        .where("id", "=", actor.userId)
        .execute();
      await expect(
        registerInvoiceSource(db, storage, actor, manual("wildcard"))
      ).rejects.toThrow("invoice_source_access_denied");
      expect(upload).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    });
    it("rejects forged paths and requires the exact recorded attachment source", async () => {
      const imported = await mercury();
      await expect(
        registerInvoiceSource(db, storage, actor, {
          kind: "mercury",
          sourceKey: "a",
          mercuryImportId: imported.id,
          storagePath: `${actor.companyId}/mercury/forged.pdf`
        })
      ).rejects.toThrow("invoice_source_attachment_unavailable");
      expect(download).not.toHaveBeenCalled();
      await expect(
        registerInvoiceSource(db, storage, actor, {
          ...manual("a"),
          storagePath: `${actor.companyId}/invoice-intake/a.pdf`
        })
      ).rejects.toThrow("invoice_source_invalid");
    });
    it("keeps a payment-only source and enriches its same intake when a document arrives", async () => {
      const imported = await mercury();
      const payment = await registerInvoiceSource(db, storage, actor, {
        kind: "mercury",
        sourceKey: "payment",
        mercuryImportId: imported.id,
        historical: true
      });
      expect(payment.status).toBe("NeedsDocument");
      const path = `${actor.companyId}/mercury/payment/receipt.pdf`;
      objects.set(path, bytes);
      await db
        .updateTable("mercuryTransactionImport")
        .set({
          attachments: JSON.stringify([
            { path, fileName: "receipt.pdf", source: "mercury" }
          ])
        })
        .where("id", "=", imported.id)
        .execute();
      const document = await registerInvoiceSource(db, storage, actor, {
        kind: "mercury",
        sourceKey: "attachment",
        mercuryImportId: imported.id,
        storagePath: path
      });
      expect(document.intakeId).toBe(payment.intakeId);
      expect(document.status).toBe("Queued");
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(2);
      // A foreign-company restore keeps opaque original keys but remaps canonical
      // import/path references. A collector retry must use that same identity.
      await db
        .updateTable("invoiceIntakeSource")
        .set({ sourceKey: sql<string>`'restored:' || "sourceKey"` })
        .where("companyId", "=", actor.companyId)
        .execute();
      const replay = await registerInvoiceSource(db, storage, actor, {
        kind: "mercury",
        sourceKey: "attachment",
        mercuryImportId: imported.id,
        storagePath: path
      });
      expect(replay.sourceId).toBe(document.sourceId);
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(2);
    });
    it("preserves ignored imports and treats non-Draft invoice links as evidence only", async () => {
      const ignored = await mercury([], "Ignored");
      expect(
        (
          await registerInvoiceSource(db, storage, actor, {
            kind: "mercury",
            sourceKey: "ignored",
            mercuryImportId: ignored.id
          })
        ).status
      ).toBe("Ignored");
      const posted = await invoice("Open");
      const imported = await mercury([], "Imported", posted.id);
      expect(
        (
          await registerInvoiceSource(db, storage, actor, {
            kind: "mercury",
            sourceKey: "posted",
            mercuryImportId: imported.id
          })
        ).status
      ).toBe("Linked");
      expect(
        (
          await db
            .selectFrom("purchaseInvoice")
            .select("status")
            .where("id", "=", posted.id)
            .executeTakeFirstOrThrow()
        ).status
      ).toBe("Open");
    });
    it.each([
      "header",
      "proposal",
      "reviewed",
      "ignored",
      "canonical-ignored",
      "revision",
      "generation",
      "line",
      "extraction",
      "invoice-link",
      "supplier-link",
      "document"
    ])("refuses to consolidate a payment placeholder with %s evidence or decisions", async (change) => {
      const canonical = await registerInvoiceSource(
        db,
        storage,
        actor,
        manual("canonical")
      );
      const path = `${actor.companyId}/mercury/installment/invoice.pdf`;
      objects.set(path, bytes);
      const imported = await mercury([
        { path, source: "gmail", fileName: "invoice.pdf" }
      ]);
      const placeholder = await registerInvoiceSource(db, storage, actor, {
        kind: "mercury",
        sourceKey: "payment",
        mercuryImportId: imported.id
      });
      const update = db
        .updateTable("invoiceIntake")
        .where("companyId", "=", actor.companyId)
        .where("id", "=", placeholder.intakeId);
      if (change === "header")
        await update
          .set({ header: JSON.stringify({ invoiceNumber: "HUMAN-REVIEW" }) })
          .execute();
      if (change === "proposal")
        await update
          .set({ newSupplier: JSON.stringify({ name: "Proposed supplier" }) })
          .execute();
      if (change === "reviewed")
        await update.set({ status: "NeedsReview" }).execute();
      if (change === "ignored")
        await update.set({ status: "Ignored" }).execute();
      if (change === "canonical-ignored")
        await db
          .updateTable("invoiceIntake")
          .set({ status: "Ignored" })
          .where("companyId", "=", actor.companyId)
          .where("id", "=", canonical.intakeId)
          .execute();
      if (change === "revision") await update.set({ revision: 1 }).execute();
      if (change === "generation")
        await update.set({ generation: 1 }).execute();
      if (change === "line")
        await db
          .insertInto("invoiceIntakeLine")
          .values({
            companyId: actor.companyId,
            createdBy: actor.userId,
            intakeId: placeholder.intakeId,
            lineKey: "human-line",
            sortOrder: 0,
            description: "Human line"
          })
          .execute();
      if (change === "extraction")
        await db
          .insertInto("documentExtraction")
          .values({
            companyId: actor.companyId,
            createdBy: actor.userId,
            intakeId: placeholder.intakeId,
            documentType: "purchaseInvoice",
            sourceDocument: "invoice.pdf",
            storagePath: path,
            generation: 0,
            inputRevision: 0,
            attemptNumber: 1,
            operation: "extract",
            status: "failed"
          })
          .execute();
      if (change === "invoice-link") {
        const draft = await invoice();
        await update.set({ purchaseInvoiceId: draft.id }).execute();
        await db
          .updateTable("mercuryTransactionImport")
          .set({ purchaseInvoiceId: draft.id })
          .where("companyId", "=", actor.companyId)
          .where("id", "=", imported.id)
          .execute();
      }
      if (change === "supplier-link") {
        const invoices = [await invoice(), await invoice()];
        const suppliers = await db
          .selectFrom("purchaseInvoice")
          .innerJoin(
            "supplierInteraction",
            "supplierInteraction.id",
            "purchaseInvoice.supplierInteractionId"
          )
          .select("supplierInteraction.supplierId")
          .where("purchaseInvoice.companyId", "=", actor.companyId)
          .where(
            "purchaseInvoice.id",
            "in",
            invoices.map((entry) => entry.id)
          )
          .execute();
        await update.set({ supplierId: suppliers[0]!.supplierId }).execute();
        await db
          .updateTable("mercuryTransactionImport")
          .set({ supplierId: suppliers[0]!.supplierId })
          .where("companyId", "=", actor.companyId)
          .where("id", "=", imported.id)
          .execute();
        await db
          .updateTable("invoiceIntake")
          .set({ supplierId: suppliers[1]!.supplierId })
          .where("companyId", "=", actor.companyId)
          .where("id", "=", canonical.intakeId)
          .execute();
      }
      if (change === "document") {
        const otherPath = `${actor.companyId}/mercury/installment/other.pdf`;
        objects.set(
          otherPath,
          new TextEncoder().encode("%PDF-1.4 Different invoice")
        );
        await db
          .updateTable("mercuryTransactionImport")
          .set({
            attachments: JSON.stringify([
              { path, source: "gmail", fileName: "invoice.pdf" },
              { path: otherPath, source: "gmail", fileName: "other.pdf" }
            ])
          })
          .where("companyId", "=", actor.companyId)
          .where("id", "=", imported.id)
          .execute();
        await registerInvoiceSource(db, storage, actor, {
          kind: "gmail",
          sourceKey: "other-file",
          mercuryImportId: imported.id,
          storagePath: otherPath
        });
      }
      const intakes = await db
        .selectFrom("invoiceIntake")
        .selectAll()
        .where("companyId", "=", actor.companyId)
        .orderBy("id")
        .execute();
      const sources = await db
        .selectFrom("invoiceIntakeSource")
        .selectAll()
        .where("companyId", "=", actor.companyId)
        .orderBy("id")
        .execute();
      await expect(
        registerInvoiceSource(db, storage, actor, {
          kind: "gmail",
          sourceKey: "duplicate-file",
          mercuryImportId: imported.id,
          storagePath: path
        })
      ).rejects.toThrow("invoice_source_intake_conflict");
      expect(
        await db
          .selectFrom("invoiceIntake")
          .selectAll()
          .where("companyId", "=", actor.companyId)
          .orderBy("id")
          .execute()
      ).toEqual(intakes);
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .selectAll()
          .where("companyId", "=", actor.companyId)
          .orderBy("id")
          .execute()
      ).toEqual(sources);
    });
    it.each([
      false,
      true
    ])("replays separately reviewed payment evidence explicitly linked to the same invoice (sole shared file: %s)", async (soleSharedFile) => {
      const native = await invoice("Open");
      const records: { importId: string; intakeId: string }[] = [];
      for (const payment of ["first", "second"]) {
        const attachments = ["shared", `${payment}-only`].map((content) => {
          const path = `${actor.companyId}/mercury/${payment}/${content}.pdf`;
          objects.set(path, new TextEncoder().encode(`%PDF-1.4 ${content}`));
          return { path, source: "gmail", fileName: `${content}.pdf` };
        });
        const imported = await mercury(attachments);
        const result = await registerMercuryInvoiceSources(
          { ...actor, db, storage },
          imported.id
        );
        records.push({ importId: imported.id, intakeId: result.intakeId });
      }
      if (soleSharedFile) {
        // Model pre-existing independently reviewed evidence whose native
        // invoice association has been explicitly confirmed by the operator.
        await db
          .deleteFrom("invoiceIntakeSource")
          .where("companyId", "=", actor.companyId)
          .where("fileName", "!=", "shared.pdf")
          .execute();
        await sql`UPDATE public."mercuryTransactionImport" SET attachments=(
          SELECT jsonb_agg(a) FROM jsonb_array_elements(attachments) a WHERE a->>'fileName'='shared.pdf'
        ) WHERE "companyId"=${actor.companyId}`.execute(db);
      }
      await db
        .updateTable("invoiceIntake")
        .set({
          status: "Linked",
          purchaseInvoiceId: native.id,
          approvedBy: actor.userId,
          approvedAt: sql<string>`now()`
        })
        .where("companyId", "=", actor.companyId)
        .execute();
      await db
        .updateTable("mercuryTransactionImport")
        .set({ reviewStatus: "Imported", purchaseInvoiceId: native.id })
        .where("companyId", "=", actor.companyId)
        .execute();
      const sources = await db
        .selectFrom("invoiceIntakeSource")
        .selectAll()
        .where("companyId", "=", actor.companyId)
        .orderBy("id")
        .execute();
      for (const record of records) {
        expect(
          await registerMercuryInvoiceSources(
            { ...actor, db, storage },
            record.importId
          )
        ).toMatchObject({ intakeId: record.intakeId, status: "Linked" });
      }
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .selectAll()
          .where("companyId", "=", actor.companyId)
          .orderBy("id")
          .execute()
      ).toEqual(sources);
      expect(
        await db
          .selectFrom("invoiceIntake")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(2);
      const third = await mercury([], "Imported", native.id);
      const registered = await registerMercuryInvoiceSources(
        { ...actor, db, storage },
        third.id
      );
      expect(registered.status).toBe("Linked");
      expect(records.map((record) => record.intakeId)).not.toContain(
        registered.intakeId
      );
      const thirdPath = `${actor.companyId}/mercury/third/shared.pdf`;
      objects.set(thirdPath, new TextEncoder().encode("%PDF-1.4 shared"));
      await db
        .updateTable("mercuryTransactionImport")
        .set({
          attachments: JSON.stringify([
            { path: thirdPath, source: "gmail", fileName: "shared.pdf" }
          ])
        })
        .where("companyId", "=", actor.companyId)
        .where("id", "=", third.id)
        .execute();
      expect(
        await registerMercuryInvoiceSources({ ...actor, db, storage }, third.id)
      ).toMatchObject({ intakeId: registered.intakeId, status: "Linked" });
      expect(
        await db
          .selectFrom("invoiceIntake")
          .select("purchaseInvoiceId")
          .where("companyId", "=", actor.companyId)
          .where("id", "=", registered.intakeId)
          .executeTakeFirstOrThrow()
      ).toEqual({ purchaseInvoiceId: native.id });
      expect(
        await db
          .selectFrom("invoiceIntakeSource")
          .selectAll()
          .where("companyId", "=", actor.companyId)
          .where("mercuryImportId", "!=", third.id)
          .orderBy("id")
          .execute()
      ).toEqual(sources);
      expect(
        await db
          .selectFrom("invoiceIntake")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(3);
      expect(
        (
          await db
            .selectFrom("purchaseInvoice")
            .select("status")
            .where("companyId", "=", actor.companyId)
            .where("id", "=", native.id)
            .executeTakeFirstOrThrow()
        ).status
      ).toBe("Open");
    });
    it("reconciles an existing source after legacy review changes its status or invoice link", async () => {
      const imported = await mercury();
      const input = {
        kind: "mercury" as const,
        sourceKey: "legacy",
        mercuryImportId: imported.id
      };
      const first = await registerInvoiceSource(db, storage, actor, input);
      const draft = await invoice();
      await db
        .updateTable("mercuryTransactionImport")
        .set({ reviewStatus: "Imported", purchaseInvoiceId: draft.id })
        .where("id", "=", imported.id)
        .execute();
      const linked = await registerInvoiceSource(db, storage, actor, input);
      expect(linked.sourceId).toBe(first.sourceId);
      expect(
        (
          await db
            .selectFrom("invoiceIntake")
            .select("purchaseInvoiceId")
            .where("id", "=", first.intakeId)
            .executeTakeFirstOrThrow()
        ).purchaseInvoiceId
      ).toBe(draft.id);
      await db
        .updateTable("mercuryTransactionImport")
        .set({ reviewStatus: "Ignored" })
        .where("id", "=", imported.id)
        .execute();
      expect(
        (await registerInvoiceSource(db, storage, actor, input)).status
      ).toBe("Ignored");
    });
    it("preserves the exact Draft identity and rejects attempts to replace its invoice link", async () => {
      const draft = await invoice();
      const other = await invoice();
      const first = await registerInvoiceSource(db, storage, actor, {
        ...manual("draft"),
        purchaseInvoiceId: draft.id
      });
      expect(first.status).toBe("Queued");
      await expect(
        registerInvoiceSource(db, storage, actor, {
          ...manual("other"),
          purchaseInvoiceId: other.id
        })
      ).rejects.toThrow("invoice_source_invoice_conflict");
      await expect(
        registerInvoiceSource(db, storage, actor, {
          ...manual("foreign"),
          purchaseInvoiceId: "missing-or-foreign"
        })
      ).rejects.toThrow("invoice_source_invoice_unavailable");
    });
    it("cannot commit a registration when storage fails", async () => {
      upload.mockResolvedValueOnce({ error: { message: "synthetic outage" } });
      await expect(
        registerInvoiceSource(db, storage, actor, manual("outage"))
      ).rejects.toThrow("invoice_source_upload_failed");
      expect(
        await db
          .selectFrom("invoiceIntake")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .execute()
      ).toHaveLength(0);
    });
  }
);
