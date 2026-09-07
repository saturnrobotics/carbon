import { randomUUID } from "node:crypto";
import type { Json } from "@carbon/database";
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

async function candidateIntake(
  f: Fixture,
  primary: string,
  other: string,
  reference: string
) {
  const value = review(f);
  value.header.invoiceNumber = reference;
  value.header.paymentReviewReason =
    "Partial payment reviewed against the invoice";
  value.header.primarySourceSha256 = primary;
  value.header.sourceAcknowledgements = [
    { sha256: other, reason: "Unrelated Gmail search candidate" }
  ];
  const row = await intake(f);
  const paid = await payment(f);
  await db
    .deleteFrom("invoiceIntakeSource")
    .where("companyId", "=", f.actor.companyId)
    .where("intakeId", "=", row.id)
    .execute();
  await db
    .insertInto("invoiceIntakeSource")
    .values(
      [primary, other].map((hash) => ({
        companyId: f.actor.companyId,
        intakeId: row.id,
        createdBy: f.actor.userId,
        kind: hash === primary ? "mercury" : "gmail",
        sourceKey: randomUUID(),
        mercuryImportId: paid.id,
        storageBucket: "private",
        storagePath: `${f.actor.companyId}/invoice-intake/${row.id}/${hash}.pdf`,
        sha256: hash,
        mediaType: "application/pdf",
        byteSize: 120
      }))
    )
    .execute();
  value.header.paymentReviewFingerprint = (
    await getInvoiceIntakeReview(db, f.actor, row.id)
  ).paymentEvidenceFingerprint;
  const saved = await saveInvoiceIntakeReview(db, f.actor, {
    id: row.id,
    expectedRevision: row.revision,
    review: value
  });
  return { ...row, ...saved, paid, value };
}

describe("Atomic invoice intake approval", () => {
  it("blocks an unmapped financial Draft line and merges the mapped receipt without doubling its total", async () =>
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
      const unmapped = await saveInvoiceIntakeReview(db, f.actor, {
        id: second.id,
        expectedRevision: 0,
        review: value
      });
      expect(unmapped.validation.ready).toBe(false);
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: second.id,
          expectedRevision: unmapped.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/financial line/i);
      value.lines[0].purchaseInvoiceLineId = native.id;
      value.lines[0].review.expectedInvoiceLineUpdatedAt =
        token.invoiceLines.find((line) => line.value === native.id)!.updatedAt;
      const mapped = await saveInvoiceIntakeReview(db, f.actor, {
        id: second.id,
        expectedRevision: unmapped.revision,
        review: value
      });
      expect(mapped.validation.ready).toBe(true);
      await approveInvoiceIntake(db, f.actor, {
        intakeId: second.id,
        expectedRevision: mapped.revision,
        approvalKey: randomUUID()
      });
      const finalLines = await db
        .selectFrom("purchaseInvoiceLine")
        .select(["quantity", "supplierUnitPrice"])
        .where("companyId", "=", f.actor.companyId)
        .where("invoiceId", "=", original.invoiceId)
        .execute();
      expect(finalLines).toHaveLength(1);
      expect(
        Number(finalLines[0].quantity) * Number(finalLines[0].supplierUnitPrice)
      ).toBe(10);
      expect(await counts(f)).toBe("0");
    }));
  it("defaults to actionable receipts and exposes payment context in missing-document follow-up", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      const paid = await payment(f, 10);
      await attach(f, row.id, paid.id);
      await db
        .updateTable("invoiceIntake")
        .set({ status: "NeedsDocument", header: {} })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", row.id)
        .execute();
      expect((await getInvoiceIntakeInbox(db, f.actor)).intakes).toHaveLength(
        0
      );
      const followup = await getInvoiceIntakeInbox(db, f.actor, {
        status: "NeedsDocument"
      });
      expect(followup.intakes[0].payments).toEqual([
        expect.objectContaining({
          id: paid.id,
          amount: "10",
          currencyCode: "USD",
          transactionDate: "2026-02-28"
        })
      ]);
      expect(
        (await getInvoiceIntakeInbox(db, f.actor, { status: "All" })).intakes
      ).toHaveLength(1);
    }));
  it("requires payment explanations to acknowledge the current bank evidence", async () =>
    fixture(async (f) => {
      const value = review(f);
      value.header.paymentReviewReason = "Reviewed partial payment";
      const row = await intake(f, value);
      const paid = await payment(f, 4);
      await attach(f, row.id, paid.id);
      const pending = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(pending.validation.ready).toBe(false);
      Object.assign(pending.review.header, {
        paymentReviewFingerprint: pending.paymentEvidenceFingerprint
      });
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        review: pending.review
      });
      expect(saved.validation.ready).toBe(true);
      await db
        .updateTable("mercuryTransactionImport")
        .set({ remoteStatus: "failed" })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", paid.id)
        .execute();
      expect(
        (await getInvoiceIntakeReview(db, f.actor, row.id)).validation.ready
      ).toBe(false);
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: saved.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/bank|payment/i);
    }));
  it("invalidates a payment explanation when the reviewed invoice amount changes", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      const paid = await payment(f, 4);
      await attach(f, row.id, paid.id);
      const pending = await getInvoiceIntakeReview(db, f.actor, row.id);
      pending.review.header.paymentReviewReason = "Reviewed partial payment";
      pending.review.header.paymentReviewFingerprint =
        pending.paymentEvidenceFingerprint;
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        review: pending.review
      });
      expect(saved.validation.ready).toBe(true);
      pending.review.header.total = "20";
      pending.review.header.subtotal = "20";
      pending.review.lines[0].supplierUnitPrice = "10";
      const changed = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: saved.revision,
        review: pending.review
      });
      expect(changed.validation.issues).toContainEqual(
        expect.objectContaining({ path: "header.paymentReviewReason" })
      );
    }));
  it("requires evidence-bound reasons for unreadable Mercury attachments alongside a valid receipt", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      const paid = await payment(f, Number(review(f).header.total));
      await attach(f, row.id, paid.id);
      const acquisition = {
        attachmentCount: 2,
        hasGeneratedReceipt: false,
        checkedAt: "2026-09-07T12:00:00Z",
        attachments: [
          {
            id: "readable",
            fileName: "invoice.pdf",
            status: "saved",
            path: "saved.pdf"
          },
          { id: "unreadable", fileName: "other.xlsx", status: "unsupported" }
        ]
      };
      await db
        .updateTable("mercuryTransactionImport")
        .set({ vendorSuggestion: { mercuryReceiptAcquisition: acquisition } })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", paid.id)
        .execute();
      const pending = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(pending.validation.ready).toBe(false);
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: row.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/attachment/i);
      const unresolved = pending.payments[0].unresolvedAttachments[0];
      const value = pending.review;
      Object.assign(value.header, {
        receiptAcknowledgements: [
          {
            mercuryImportId: paid.id,
            attachmentId: unresolved.id,
            fingerprint: unresolved.fingerprint,
            reason:
              "Reviewed separately; supporting packing list, no invoice lines"
          }
        ]
      });
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        review: value
      });
      expect(saved.validation.ready).toBe(true);
      acquisition.attachments[1].fileName = "different-document.xlsx";
      await db
        .updateTable("mercuryTransactionImport")
        .set({ vendorSuggestion: { mercuryReceiptAcquisition: acquisition } })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", paid.id)
        .execute();
      expect(
        (await getInvoiceIntakeReview(db, f.actor, row.id)).validation.ready
      ).toBe(false);
      expect(await counts(f)).toBe("0");
    }));
  it("retains pending extraction review across ordinary saves until explicitly acknowledged", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      await db
        .updateTable("invoiceIntake")
        .set({
          header: sql<Json>`header || jsonb_build_object('_pendingExtractionReview','new-attempt')`
        })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", row.id)
        .execute();
      const pending = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(pending.validation.ready).toBe(false);
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        review: pending.review
      });
      expect(saved.validation.ready).toBe(false);
      const after = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(after.pendingExtractionReviewId).toBe("new-attempt");
      Object.assign(after.review.header, { extractionReviewId: "new-attempt" });
      const acknowledged = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: saved.revision,
        review: after.review
      });
      expect(acknowledged.validation.ready).toBe(true);
      expect(
        (await getInvoiceIntakeReview(db, f.actor, row.id))
          .pendingExtractionReviewId
      ).toBeNull();
    }));
  it("requires an explanation for a payment difference and retains the reviewed evidence", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      const paid = await payment(f, 12);
      await attach(f, row.id, paid.id);
      const before = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(before.paymentReconciliation).toMatchObject({
        status: "difference",
        difference: "2"
      });
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: row.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/difference/);
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        review: {
          ...before.review,
          header: {
            ...before.review.header,
            paymentReviewFingerprint: before.paymentEvidenceFingerprint,
            paymentReviewReason:
              "Payment includes a separate charge awaiting reconciliation"
          }
        }
      });
      const approved = await approveInvoiceIntake(db, f.actor, {
        intakeId: row.id,
        expectedRevision: saved.revision,
        approvalKey: randomUUID()
      });
      const persisted = await db
        .selectFrom("invoiceIntake")
        .select("approvalSnapshot")
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      expect(persisted.approvalSnapshot).toMatchObject({
        sourceSha256s: ["a".repeat(64)],
        payments: [expect.objectContaining({ amount: "12" })],
        paymentReconciliation: { difference: "2" },
        resolved: { header: { total: "10" } }
      });
      expect(approved.status).toBe("Approved");
      expect(await counts(f)).toBe("0");
    }));
  it("does not approve deferred Gmail evidence as a Mercury receipt", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      await db
        .updateTable("invoiceIntakeSource")
        .set({ kind: "gmail" })
        .where("companyId", "=", f.actor.companyId)
        .where("intakeId", "=", row.id)
        .execute();
      const current = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(current.eligibleSourceIds).toEqual([]);
      expect(current.validation.ready).toBe(false);
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: row.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/Attach/);
    }));

  it("preserves missing-document status when an incomplete review is saved", async () =>
    fixture(async (f) => {
      const row = await db
        .insertInto("invoiceIntake")
        .values({
          companyId: f.actor.companyId,
          createdBy: f.actor.userId,
          status: "NeedsDocument"
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: 0,
        review: invoiceIntakeReviewValidator.parse({ header: {}, lines: [] })
      });
      expect(saved.status).toBe("NeedsDocument");
      const current = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(current.intake.status).toBe("NeedsDocument");
    }));
  it("keeps linked Mercury payment context visible with no receipt", async () =>
    fixture(async (f) => {
      const imported = await payment(f, 12);
      await db
        .updateTable("mercuryTransactionImport")
        .set({
          memo: "EXAMPLE RECEIPT",
          reference: "EXAMPLE-REF",
          vendorSuggestion: { name: "Example Vendor" }
        })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", imported.id)
        .execute();
      const row = await db
        .insertInto("invoiceIntake")
        .values({
          companyId: f.actor.companyId,
          createdBy: f.actor.userId,
          status: "NeedsDocument"
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: f.actor.companyId,
          intakeId: row.id,
          createdBy: f.actor.userId,
          kind: "mercury",
          sourceKey: randomUUID(),
          mercuryImportId: imported.id
        })
        .execute();
      const current = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(current.payments).toEqual([
        expect.objectContaining({
          id: imported.id,
          amount: "12",
          currencyCode: "USD",
          payee: "Example Vendor",
          memo: "EXAMPLE RECEIPT",
          reference: "EXAMPLE-REF"
        })
      ]);
      expect(current.eligibleSourceIds).toEqual([]);
    }));

  it("preserves legacy single-file ownership after later supporting evidence arrives", async () =>
    fixture(async (f) => {
      const first = await intake(f);
      const approved = await approveInvoiceIntake(db, f.actor, {
        intakeId: first.id,
        expectedRevision: first.revision,
        approvalKey: randomUUID()
      });
      // Older approvals relied on an implicit sole-file primary instead of
      // persisting that choice in their snapshot.
      await db
        .updateTable("invoiceIntake")
        .set({
          header: sql`header-'primarySourceSha256'`,
          approvalSnapshot: sql`"approvalSnapshot"#-'{resolved,header,primarySourceSha256}'`
        })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", first.id)
        .execute();
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: f.actor.companyId,
          intakeId: first.id,
          createdBy: f.actor.userId,
          kind: "upload",
          sourceKey: randomUUID(),
          storageBucket: "private",
          storagePath: `${f.actor.companyId}/invoice-intake/${first.id}/later.pdf`,
          sha256: "b".repeat(64),
          mediaType: "application/pdf",
          byteSize: 120
        })
        .execute();
      const second = await candidateIntake(
        f,
        "a".repeat(64),
        "c".repeat(64),
        "LEGACY-RETRY"
      );
      expect(second.status).toBe("NeedsReview");
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: second.id,
          expectedRevision: second.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/primary document already belongs/);
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: second.id,
        expectedRevision: second.revision,
        review: {
          ...second.value,
          purchaseInvoiceId: approved.invoiceId,
          mergeMode: "evidence",
          lines: []
        }
      });
      expect(saved.status).toBe("Ready");
      await approveInvoiceIntake(db, f.actor, {
        intakeId: second.id,
        expectedRevision: saved.revision,
        approvalKey: randomUUID()
      });
      expect(
        await db
          .selectFrom("purchaseInvoice")
          .select("id")
          .where("companyId", "=", f.actor.companyId)
          .execute()
      ).toHaveLength(1);
      expect(await counts(f)).toBe("0");
    }));
  it("does not treat a metadata-only hash as an attached document", async () =>
    fixture(async (f) => {
      const row = await intake(f);
      await db
        .updateTable("invoiceIntakeSource")
        .set({ storageBucket: null, storagePath: null })
        .where("companyId", "=", f.actor.companyId)
        .where("intakeId", "=", row.id)
        .execute();
      const current = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(current.validation.ready).toBe(false);
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: row.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/Attach the invoice/);
      expect(
        await db
          .selectFrom("purchaseInvoice")
          .select("id")
          .where("companyId", "=", f.actor.companyId)
          .execute()
      ).toHaveLength(0);
    }));
  it("serializes shared primary approval and permits an explicit link to the same invoice", async () =>
    fixture(async (f) => {
      const first = await candidateIntake(
        f,
        "a".repeat(64),
        "b".repeat(64),
        "CANDIDATE-1"
      );
      const second = await candidateIntake(
        f,
        "a".repeat(64),
        "c".repeat(64),
        "DIFFERENT-OCR-REFERENCE"
      );
      expect([first.status, second.status]).toEqual(["Ready", "Ready"]);
      const results = await Promise.allSettled(
        [first, second].map((row) =>
          approveInvoiceIntake(db, f.actor, {
            intakeId: row.id,
            expectedRevision: row.revision,
            approvalKey: randomUUID()
          })
        )
      );
      const success = results.find((result) => result.status === "fulfilled");
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1);
      if (!success || success.status !== "fulfilled")
        throw new Error("Expected one approval");
      const remaining = results[0].status === "rejected" ? first : second;
      const current = await getInvoiceIntakeReview(db, f.actor, remaining.id);
      expect(current.validation.ready).toBe(false);
      expect(
        current.validation.issues.some((issue) =>
          issue.message.includes("primary document already belongs")
        )
      ).toBe(true);
      expect(
        current.invoiceOptions.some(
          (option) => option.value === success.value.invoiceId
        )
      ).toBe(true);
      const linked = {
        ...remaining.value,
        purchaseInvoiceId: success.value.invoiceId,
        mergeMode: "evidence",
        lines: []
      };
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: remaining.id,
        expectedRevision: remaining.revision,
        review: linked
      });
      expect(saved.status).toBe("Ready");
      await approveInvoiceIntake(db, f.actor, {
        intakeId: remaining.id,
        expectedRevision: saved.revision,
        approvalKey: randomUUID()
      });
      const invoices = await db
        .selectFrom("purchaseInvoice")
        .select("id")
        .where("companyId", "=", f.actor.companyId)
        .execute();
      expect(invoices).toHaveLength(1);
      const payments = await db
        .selectFrom("mercuryTransactionImport")
        .select(["purchaseInvoiceId", "reviewStatus"])
        .where("companyId", "=", f.actor.companyId)
        .execute();
      expect(payments).toHaveLength(2);
      expect(
        payments.every(
          (row) =>
            row.purchaseInvoiceId === success.value.invoiceId &&
            row.reviewStatus === "Imported"
        )
      ).toBe(true);
      expect(await counts(f)).toBe("0");
    }));
  it("keeps separate invoices and payments when only their supporting candidates overlap", async () =>
    fixture(async (f) => {
      const first = await candidateIntake(
        f,
        "b".repeat(64),
        "a".repeat(64),
        "DISTINCT-1"
      );
      const second = await candidateIntake(
        f,
        "c".repeat(64),
        "a".repeat(64),
        "DISTINCT-2"
      );
      const results = await Promise.all(
        [first, second].map((row) =>
          approveInvoiceIntake(db, f.actor, {
            intakeId: row.id,
            expectedRevision: row.revision,
            approvalKey: randomUUID()
          })
        )
      );
      expect(new Set(results.map((row) => row.invoiceId)).size).toBe(2);
      const payments = await db
        .selectFrom("mercuryTransactionImport")
        .select(["id", "purchaseInvoiceId"])
        .where("companyId", "=", f.actor.companyId)
        .execute();
      expect(
        payments.find((row) => row.id === first.paid.id)?.purchaseInvoiceId
      ).toBe(results[0].invoiceId);
      expect(
        payments.find((row) => row.id === second.paid.id)?.purchaseInvoiceId
      ).toBe(results[1].invoiceId);
      expect(await counts(f)).toBe("0");
    }));
  it("refuses a changed primary that supports only one of several grouped payments", async () =>
    fixture(async (f) => {
      const row = await candidateIntake(
        f,
        "b".repeat(64),
        "a".repeat(64),
        "GROUPED"
      );
      const second = await payment(f);
      await attach(f, row.id, second.id);
      const refreshed = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(refreshed.validation.ready).toBe(false);
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: row.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/every grouped payment/);
      const payments = await db
        .selectFrom("mercuryTransactionImport")
        .select("purchaseInvoiceId")
        .where("companyId", "=", f.actor.companyId)
        .execute();
      expect(payments.every((row) => row.purchaseInvoiceId === null)).toBe(
        true
      );
      expect(await counts(f)).toBe("0");
    }));
  it("requires explicit coverage of every distinct source before saving Ready or approving", async () =>
    fixture(async (f) => {
      const value = review(f);
      const row = await intake(f, value);
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: f.actor.companyId,
          intakeId: row.id,
          createdBy: f.actor.userId,
          kind: "upload",
          sourceKey: randomUUID(),
          storageBucket: "private",
          storagePath: `${f.actor.companyId}/invoice-intake/${row.id}/second.pdf`,
          sha256: "b".repeat(64),
          mediaType: "application/pdf",
          byteSize: 120
        })
        .execute();
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: row.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/source|document/i);
      const selected = {
        ...value,
        header: {
          ...value.header,
          primarySourceSha256: "a".repeat(64),
          sourceAcknowledgements: []
        }
      };
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        review: selected
      });
      expect(saved.status).toBe("NeedsReview");
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: saved.revision,
          approvalKey: randomUUID(),
          decisions: selected
        })
      ).rejects.toThrow(/source|document/i);
      const confirmed = {
        ...selected,
        header: {
          ...selected.header,
          sourceAcknowledgements: [
            {
              sha256: "b".repeat(64),
              reason: "Supporting payment evidence; no additional invoice lines"
            }
          ]
        }
      };
      const ready = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: saved.revision,
        review: confirmed
      });
      expect(ready.status).toBe("Ready");
      const result = await approveInvoiceIntake(db, f.actor, {
        intakeId: row.id,
        expectedRevision: ready.revision,
        approvalKey: randomUUID()
      });
      expect(result.status).toBe("Approved");
    }));
  it("requires manual confirmation when selecting a different source from the completed extraction", async () =>
    fixture(async (f) => {
      const value = review(f);
      const row = await intake(f, value);
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: f.actor.companyId,
          intakeId: row.id,
          createdBy: f.actor.userId,
          kind: "upload",
          sourceKey: randomUUID(),
          storageBucket: "private",
          storagePath: `${f.actor.companyId}/invoice-intake/${row.id}/second.pdf`,
          sha256: "b".repeat(64),
          mediaType: "application/pdf",
          byteSize: 120
        })
        .execute();
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
          sourceDocument: "Invoice Intake",
          storagePath: `${f.actor.companyId}/invoice-intake/${row.id}/source.pdf`,
          status: "completed",
          extractedData: emptyInvoiceExtraction()
        })
        .execute();
      const selected = {
        ...value,
        header: {
          ...value.header,
          primarySourceSha256: "b".repeat(64),
          sourceAcknowledgements: [
            {
              sha256: "a".repeat(64),
              reason: "Old bank confirmation excluded from invoice lines"
            }
          ]
        }
      };
      const saved = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: row.revision,
        review: selected
      });
      expect(saved.status).toBe("NeedsReview");
      const current = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(current.sourceCoverage.extractionSha256).toBe("a".repeat(64));
      expect(current.extraction).toBeNull();
      await expect(
        approveInvoiceIntake(db, f.actor, {
          intakeId: row.id,
          expectedRevision: saved.revision,
          approvalKey: randomUUID()
        })
      ).rejects.toThrow(/manually reviewed/);
      const confirmed = {
        ...selected,
        header: {
          ...selected.header,
          sourceAcknowledgements: [
            ...selected.header.sourceAcknowledgements,
            {
              sha256: "b".repeat(64),
              reason:
                "Manually transcribed and checked all invoice facts from selected invoice"
            }
          ]
        }
      };
      const ready = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: saved.revision,
        review: confirmed
      });
      expect(ready.status).toBe("Ready");
      const queued = await setInvoiceIntakeStatus(db, f.actor, {
        id: row.id,
        expectedRevision: ready.revision,
        action: "retry"
      });
      expect(queued.status).toBe("Queued");
      expect(queued.generation).toBe(1);
      const retained = await getInvoiceIntakeReview(db, f.actor, row.id);
      expect(retained.review.header.primarySourceSha256).toBe("b".repeat(64));
      expect(retained.review.lines).toEqual(current.review.lines);
      // A failed reparse must not erase the old source provenance and let its
      // retained facts pass as facts from the newly selected file.
      await db
        .updateTable("invoiceIntake")
        .set({ status: "NeedsReview" })
        .where("companyId", "=", f.actor.companyId)
        .where("id", "=", row.id)
        .execute();
      const afterFailure = await saveInvoiceIntakeReview(db, f.actor, {
        id: row.id,
        expectedRevision: queued.revision,
        review: selected
      });
      expect(afterFailure.status).toBe("NeedsReview");
      expect(
        (await getInvoiceIntakeReview(db, f.actor, row.id)).sourceCoverage
          .extractionSha256
      ).toBe("a".repeat(64));
    }));
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
      const inbox = await getInvoiceIntakeInbox(db, f.actor, { status: "All" });
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
          storagePath: `${f.actor.companyId}/invoice-intake/${row.id}/source.pdf`,
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
      expect(missing.status).toBe("NeedsDocument");
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
      // This is another invoice, so its source bytes must also be distinct.
      await db
        .updateTable("invoiceIntakeSource")
        .set({ sha256: "f".repeat(64) })
        .where("companyId", "=", f.actor.companyId)
        .where("intakeId", "=", staged.id)
        .execute();
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
            storagePath: `${f.actor.companyId}/invoice-intake/${row.id}/source.pdf`,
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
      const multiple = await prepare(review(f));
      await db
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: f.actor.companyId,
          intakeId: multiple.intakeId,
          createdBy: f.actor.userId,
          kind: "upload",
          sourceKey: randomUUID(),
          storageBucket: "private",
          storagePath: `${f.actor.companyId}/invoice-intake/${multiple.intakeId}/second.pdf`,
          sha256: "b".repeat(64),
          mediaType: "application/pdf",
          byteSize: 120
        })
        .execute();
      expect(await validateHydratedInvoiceIntake(multiple)).toMatchObject({
        validated: true
      });
      expect(
        (await getInvoiceIntakeReview(db, f.actor, multiple.intakeId)).intake
          .status
      ).toBe("NeedsReview");
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
