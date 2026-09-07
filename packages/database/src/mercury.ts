import { sql } from "kysely";
import { z } from "zod";
import type { Kysely, KyselyDatabase, KyselyTx } from "./client";
import { getNextSequence } from "./sequence";
import type { Database } from "./types";

// These contracts contain normalized evidence only. Bank and mailbox credentials
// belong in the deployment secret store and must never enter these records.
export const mercuryVendorSuggestionSchema = z.object({
  name: z.string().max(500).default(""),
  email: z.string().max(320).nullable().optional(),
  source: z.string().max(200).optional(),
  reason: z.string().max(2000).optional()
});

export const mercuryInvoiceEvidenceSchema = z.object({
  mailbox: z.string(),
  messageId: z.string(),
  subject: z.string(),
  from: z.string(),
  date: z.string(),
  score: z.number(),
  reasons: z.array(z.string())
});

export const mercuryAttachmentSchema = z.object({
  path: z.string(),
  fileName: z.string(),
  source: z.enum(["mercury", "gmail"]),
  mailbox: z.string().optional(),
  messageId: z.string().optional()
});

export type MercuryVendorSuggestion = z.infer<
  typeof mercuryVendorSuggestionSchema
>;
export type MercuryInvoiceEvidence = z.infer<
  typeof mercuryInvoiceEvidenceSchema
>;
export type MercuryAttachment = z.infer<typeof mercuryAttachmentSchema>;
export type MercurySyncSettings =
  Database["public"]["Tables"]["mercurySyncSettings"]["Row"];
export type MercuryTransactionImport =
  Database["public"]["Tables"]["mercuryTransactionImport"]["Row"];
export type MercuryRecipientMapping =
  Database["public"]["Tables"]["mercuryRecipientMapping"]["Row"];

export function parseMercuryVendorSuggestion(
  value: unknown
): MercuryVendorSuggestion {
  const parsed = mercuryVendorSuggestionSchema.safeParse(value);
  return parsed.success ? parsed.data : { name: "" };
}

export function parseMercuryInvoiceEvidence(
  value: unknown
): MercuryInvoiceEvidence[] {
  const parsed = z.array(mercuryInvoiceEvidenceSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function parseMercuryAttachments(value: unknown): MercuryAttachment[] {
  const parsed = z.array(mercuryAttachmentSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Restrict source copies to the company's import area, never arbitrary objects. */
export function isMercuryAttachmentPath(
  companyId: string,
  path: string
): boolean {
  return (
    path.startsWith(`${companyId}/mercury/`) &&
    !path.split("/").some((part) => part === ".." || part === ".") &&
    Array.from(path).every(
      (character) => character !== "\\" && character.charCodeAt(0) >= 32
    )
  );
}

export class MercuryImportError extends Error {}

export type MercuryApprovalInput = {
  companyId: string;
  userId: string;
  importId: string;
  purchaseInvoiceId?: string;
  supplierId?: string;
  supplierName?: string;
  supplierEmail?: string;
};

/** Acquire before any invoice/intake/payment row lock in an approval transaction. */
export async function lockCompanyInvoiceApproval(
  trx: KyselyTx,
  companyId: string
) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-approval:${companyId}`}, 0))`.execute(
    trx
  );
}

/** Caller authorizes invoicing_create and purchasing_create before entering. */
export async function approveMercuryImport(
  db: Kysely<KyselyDatabase>,
  input: MercuryApprovalInput
) {
  return db.transaction().execute(async (trx) => {
    await lockCompanyInvoiceApproval(trx, input.companyId);
    const record = await trx
      .selectFrom("mercuryTransactionImport")
      .selectAll()
      .where("id", "=", input.importId)
      .where("companyId", "=", input.companyId)
      .forUpdate()
      .executeTakeFirst();
    if (!record) throw new MercuryImportError("Payment import not found");
    if (record.reviewStatus === "Ignored") {
      throw new MercuryImportError(
        "Restore this payment to review before importing it"
      );
    }
    if (record.purchaseInvoiceId) {
      const invoice = await trx
        .selectFrom("purchaseInvoice")
        .select(["id", "supplierInteractionId"])
        .where("id", "=", record.purchaseInvoiceId)
        .where("companyId", "=", input.companyId)
        .executeTakeFirstOrThrow();
      return {
        invoiceId: invoice.id,
        interactionId: invoice.supplierInteractionId,
        attachments: parseMercuryAttachments(record.attachments)
      };
    }

    const company = await trx
      .selectFrom("company")
      .select("baseCurrencyCode")
      .where("id", "=", input.companyId)
      .executeTakeFirstOrThrow();
    if (
      !input.purchaseInvoiceId &&
      record.currencyCode !== company.baseCurrencyCode
    ) {
      throw new MercuryImportError(
        "A verified exchange rate is required before importing an invoice in this currency"
      );
    }

    // Separate payment rows for one recipient must not create duplicate suppliers.
    if (record.mercuryRecipientId) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mercury-recipient:${input.companyId}:${record.mercuryRecipientId}`}, 0))`.execute(
        trx
      );
    }
    const mapping = record.mercuryRecipientId
      ? await trx
          .selectFrom("mercuryRecipientMapping")
          .select("supplierId")
          .where("companyId", "=", input.companyId)
          .where("mercuryRecipientId", "=", record.mercuryRecipientId)
          .executeTakeFirst()
      : undefined;
    if (
      mapping &&
      input.supplierId &&
      mapping.supplierId !== input.supplierId
    ) {
      throw new MercuryImportError(
        "This Mercury recipient is already linked to a different supplier"
      );
    }
    const existingInvoice = input.purchaseInvoiceId
      ? await trx
          .selectFrom("purchaseInvoice")
          .select([
            "id",
            "supplierId",
            "supplierInteractionId",
            "currencyCode",
            "status"
          ])
          .where("id", "=", input.purchaseInvoiceId)
          .where("companyId", "=", input.companyId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (input.purchaseInvoiceId && !existingInvoice)
      throw new MercuryImportError("Invoice not found in this company");
    if (
      existingInvoice &&
      (existingInvoice.currencyCode !== record.currencyCode ||
        existingInvoice.status === "Voided")
    ) {
      throw new MercuryImportError(
        "Choose a non-voided invoice in the payment's currency"
      );
    }
    if (
      existingInvoice &&
      (!existingInvoice.supplierId ||
        (input.supplierId && input.supplierId !== existingInvoice.supplierId) ||
        (mapping && mapping.supplierId !== existingInvoice.supplierId))
    ) {
      throw new MercuryImportError(
        "The selected invoice belongs to a different supplier"
      );
    }
    let supplierId =
      mapping?.supplierId ?? input.supplierId ?? existingInvoice?.supplierId;
    let contactId: string | undefined;
    if (supplierId) {
      const supplier = await trx
        .selectFrom("supplier")
        .select("id")
        .where("id", "=", supplierId)
        .where("companyId", "=", input.companyId)
        .executeTakeFirst();
      if (!supplier)
        throw new MercuryImportError("Supplier not found in this company");
    } else {
      const name = input.supplierName?.trim();
      if (!name)
        throw new MercuryImportError("Confirm the new supplier's name");
      const approvalRule = await trx
        .selectFrom("approvalRule")
        .select("id")
        .where("companyId", "=", input.companyId)
        .where("documentType", "=", "supplier")
        .where("enabled", "=", true)
        .where("lowerBoundAmount", "=", 0)
        .executeTakeFirst();
      const supplier = await trx
        .insertInto("supplier")
        .values({
          name,
          companyId: input.companyId,
          currencyCode: record.currencyCode,
          supplierStatus: approvalRule ? "Pending" : "Active",
          createdBy: input.userId,
          updatedBy: input.userId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      supplierId = supplier.id;
      if (input.supplierEmail) {
        const contact = await trx
          .insertInto("contact")
          .values({
            companyId: input.companyId,
            email: input.supplierEmail,
            firstName: name,
            isCustomer: false
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const link = await trx
          .insertInto("supplierContact")
          .values({
            companyId: input.companyId,
            supplierId,
            contactId: contact.id
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        contactId = link.id;
      }
    }
    if (record.mercuryRecipientId && !mapping) {
      await trx
        .insertInto("mercuryRecipientMapping")
        .values({
          companyId: input.companyId,
          mercuryRecipientId: record.mercuryRecipientId,
          supplierId,
          createdBy: input.userId,
          updatedBy: input.userId
        })
        .execute();
    }
    let invoiceId: string;
    let interactionId: string;
    if (existingInvoice) {
      invoiceId = existingInvoice.id;
      interactionId = existingInvoice.supplierInteractionId;
    } else {
      const interaction = await trx
        .insertInto("supplierInteraction")
        .values({
          supplierId,
          companyId: input.companyId
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const number = await getNextSequence(
        trx,
        "purchaseInvoice",
        input.companyId
      );
      const invoice = await trx
        .insertInto("purchaseInvoice")
        .values({
          companyId: input.companyId,
          createdBy: input.userId,
          updatedBy: input.userId,
          supplierId,
          invoiceSupplierId: supplierId,
          invoiceSupplierContactId: contactId,
          supplierInteractionId: interaction.id,
          invoiceId: number,
          currencyCode: record.currencyCode,
          exchangeRate: 1,
          status: "Draft",
          // Payment dates, references and totals are evidence on the import record;
          // they are not necessarily the vendor invoice's date, number or total.
          dateIssued: null,
          dateDue: null
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("purchaseInvoiceDelivery")
        .values({
          id: invoice.id,
          companyId: input.companyId
        })
        .execute();
      invoiceId = invoice.id;
      interactionId = interaction.id;
    }
    await trx
      .updateTable("mercuryTransactionImport")
      .set({
        reviewStatus: "Imported",
        supplierId,
        purchaseInvoiceId: invoiceId,
        updatedBy: input.userId,
        updatedAt: sql<string>`now()`,
        lastError: null
      })
      .where("id", "=", record.id)
      .where("companyId", "=", input.companyId)
      .execute();
    return {
      invoiceId,
      interactionId,
      attachments: parseMercuryAttachments(record.attachments)
    };
  });
}
