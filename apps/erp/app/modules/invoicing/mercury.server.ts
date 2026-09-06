import { createHash } from "node:crypto";
import type { Database } from "@carbon/database";
import { fetchAllFromTable } from "@carbon/database";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import {
  approveMercuryImport,
  isMercuryAttachmentPath,
  type MercuryApprovalInput,
  MercuryImportError,
  parseMercuryAttachments,
  parseMercuryInvoiceEvidence,
  parseMercuryVendorSuggestion
} from "@carbon/database/mercury";
import { getEnv } from "@carbon/env";
import { parseDate } from "@internationalized/date";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import { z } from "zod";
import type { mercurySettingsValidator } from "./invoicing.models";

const optionalSecret = (name: string) =>
  getEnv(name, { isRequired: false, isSecret: true });
const mailboxSchema = z.object({
  email: z.string().email(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  enabled: z.boolean().optional()
});

export function assertMercuryRequestOrigin(request: Request) {
  // Cookie-authenticated mutations must originate from this ERP, including
  // requests from other same-site apps. A custom header must not bypass this.
  const expected = new URL(
    getEnv("ERP_URL", { isRequired: false, isSecret: false }) || request.url
  ).origin;
  if (request.headers.get("origin") !== expected) {
    throw new Response("This change must be submitted from the ERP", {
      status: 403
    });
  }
}

/** Return safe status only; never serialize the parsed credential records. */
export function getMercuryConnectionStatus(companyId: string) {
  const isBound = optionalSecret("PAYMENT_SYNC_COMPANY_ID") === companyId;
  if (!isBound)
    return {
      isBound: false,
      mercuryReady: false,
      mailboxes: [] as { email: string; enabled: boolean }[],
      gmailConfigurationError: false
    };
  let mailboxes: { email: string; enabled: boolean }[] = [];
  let gmailConfigurationError = false;
  const rawMailboxes = optionalSecret("GMAIL_ACCOUNTS_JSON");
  if (rawMailboxes) {
    try {
      mailboxes = z
        .array(mailboxSchema)
        .parse(JSON.parse(rawMailboxes))
        .map(({ email, enabled }) => ({
          email: email.toLowerCase(),
          enabled: enabled !== false
        }));
    } catch {
      gmailConfigurationError = true;
    }
  }
  return {
    isBound: true,
    mercuryReady: Boolean(optionalSecret("MERCURY_API_TOKEN")),
    mailboxes,
    gmailConfigurationError
  };
}

export async function getMercuryReviewPage(
  client: SupabaseClient<Database>,
  companyId: string,
  status: "Pending" | "Imported" | "Ignored",
  offset: number
) {
  const [settings, imports, suppliers, invoices] = await Promise.all([
    client
      .from("mercurySyncSettings")
      .select("*")
      .eq("companyId", companyId)
      .maybeSingle(),
    client
      .from("mercuryTransactionImport")
      .select("*")
      .eq("companyId", companyId)
      .eq("reviewStatus", status)
      .order("createdAt", { ascending: false })
      .order("id")
      .range(offset, offset + 50),
    fetchAllFromTable<{ id: string; name: string }>(
      client,
      "supplier",
      "id,name",
      (query) => query.eq("companyId", companyId).order("name")
    ),
    fetchAllFromTable<{
      id: string;
      invoiceId: string;
      supplierId: string | null;
      currencyCode: string;
      status: string;
    }>(
      client,
      "purchaseInvoice",
      "id,invoiceId,supplierId,currencyCode,status",
      (query) =>
        query
          .eq("companyId", companyId)
          .neq("status", "Voided")
          .order("createdAt", { ascending: false })
    )
  ]);
  if (settings.error || imports.error || invoices.error)
    throw new Error("Unable to load payment imports");
  return {
    settings: settings.data,
    imports: (imports.data ?? []).slice(0, 50).map((record) => ({
      ...record,
      vendorSuggestion: parseMercuryVendorSuggestion(record.vendorSuggestion),
      invoiceEvidence: parseMercuryInvoiceEvidence(record.invoiceEvidence),
      attachments: parseMercuryAttachments(record.attachments).filter(
        (attachment) => isMercuryAttachmentPath(companyId, attachment.path)
      )
    })),
    hasMore: (imports.data?.length ?? 0) > 50,
    suppliers: suppliers.data ?? [],
    invoices: invoices.data ?? [],
    connection: getMercuryConnectionStatus(companyId)
  };
}

/** The route requires settings_update and invoicing_view. */
export async function saveMercurySettings(
  db: Kysely<KyselyDatabase>,
  companyId: string,
  userId: string,
  input: z.infer<typeof mercurySettingsValidator>
) {
  const connection = getMercuryConnectionStatus(companyId);
  if (input.enabled && !connection.mercuryReady) {
    throw new MercuryImportError(
      "Configure the Mercury connection for this company before enabling sync"
    );
  }
  let syncFromDate: string | null = null;
  if (input.syncFromDate) {
    try {
      syncFromDate = parseDate(input.syncFromDate).toString();
    } catch {
      throw new MercuryImportError("Enter a valid history start date");
    }
  }
  const knownMailboxes = new Set(
    connection.mailboxes.map(({ email }) => email)
  );
  const disabledMailboxes = [
    ...new Set(input.disabledMailboxes.map((email) => email.toLowerCase()))
  ].filter((email) => knownMailboxes.has(email));
  await db
    .insertInto("mercurySyncSettings")
    .values({
      companyId,
      enabled: input.enabled,
      gmailEnabled: input.gmailEnabled,
      disabledMailboxes,
      syncFromDate,
      createdBy: userId,
      updatedBy: userId
    })
    .onConflict((conflict) =>
      conflict.column("companyId").doUpdateSet({
        enabled: input.enabled,
        gmailEnabled: input.gmailEnabled,
        disabledMailboxes,
        cursor: sql<
          string | null
        >`CASE WHEN "mercurySyncSettings"."syncFromDate" IS DISTINCT FROM ${syncFromDate}::date THEN NULL ELSE "mercurySyncSettings"."cursor" END`,
        eventCursor: sql<
          string | null
        >`CASE WHEN "mercurySyncSettings"."syncFromDate" IS DISTINCT FROM ${syncFromDate}::date THEN NULL ELSE "mercurySyncSettings"."eventCursor" END`,
        syncFromDate,
        updatedBy: userId,
        updatedAt: sql<string>`now()`
      })
    )
    .execute();
}

export async function setMercuryReviewStatus(
  db: Kysely<KyselyDatabase>,
  companyId: string,
  userId: string,
  importId: string,
  reviewStatus: "Pending" | "Ignored"
) {
  const result = await db
    .updateTable("mercuryTransactionImport")
    .set({
      reviewStatus,
      updatedBy: userId,
      updatedAt: sql<string>`now()`
    })
    .where("id", "=", importId)
    .where("companyId", "=", companyId)
    .where("purchaseInvoiceId", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!result)
    throw new MercuryImportError(
      "This payment is unavailable or already has an invoice"
    );
}

export async function approveMercuryReview(
  db: Kysely<KyselyDatabase>,
  client: SupabaseClient<Database>,
  input: MercuryApprovalInput
) {
  const result = await approveMercuryImport(db, input);
  const folder = `${input.companyId}/supplier-interaction/${result.interactionId}`;
  const bucket = client.storage.from("private");
  let attachmentError = false;
  try {
    const existing = await bucket.list(folder, { limit: 1000 });
    if (existing.error) throw new Error("Attachment listing failed");
    const names = new Set(existing.data.map(({ name }) => name));
    const copies = await Promise.all(
      result.attachments.map(async (attachment) => {
        if (!isMercuryAttachmentPath(input.companyId, attachment.path))
          return false;
        const hash = createHash("sha256")
          .update(attachment.path)
          .digest("hex")
          .slice(0, 16);
        const name = `${hash}-${attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-160) || "invoice"}`;
        if (names.has(name)) return true;
        const copied = await bucket.copy(attachment.path, `${folder}/${name}`);
        if (!copied.error) return true;
        // A concurrent retry may have copied the same immutable source already.
        const check = await bucket.list(folder, { search: name, limit: 10 });
        return !check.error && check.data.some((file) => file.name === name);
      })
    );
    attachmentError = copies.some((copied) => !copied);
  } catch {
    attachmentError = true;
  }
  await db
    .updateTable("mercuryTransactionImport")
    .set({
      lastError: attachmentError ? "ATTACHMENT_COPY_FAILED" : null,
      updatedAt: sql<string>`now()`,
      updatedBy: input.userId
    })
    .where("id", "=", input.importId)
    .where("companyId", "=", input.companyId)
    .execute();
  return { invoiceId: result.invoiceId, attachmentError };
}
