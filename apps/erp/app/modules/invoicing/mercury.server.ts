import type { Database } from "@carbon/database";
import { fetchAllFromTable } from "@carbon/database";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import {
  approveMercuryImport,
  isMercuryAttachmentPath,
  lockCompanyInvoiceApproval,
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
  const importIds = (imports.data ?? []).slice(0, 50).map((row) => row.id);
  const intakeSources = importIds.length
    ? await client
        .from("invoiceIntakeSource")
        .select("mercuryImportId,intakeId")
        .eq("companyId", companyId)
        .in("mercuryImportId", importIds)
        .order("createdAt", { ascending: false })
    : { data: [], error: null };
  if (intakeSources.error)
    throw new Error("Unable to load invoice document links");
  const intakeIds = new Map(
    (intakeSources.data ?? []).map((source) => [
      source.mercuryImportId,
      source.intakeId
    ])
  );
  return {
    settings: settings.data,
    imports: (imports.data ?? []).slice(0, 50).map((record) => ({
      ...record,
      invoiceIntakeId: intakeIds.get(record.id) ?? null,
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
  await db.transaction().execute(async (trx) => {
    await lockCompanyInvoiceApproval(trx, companyId);
    const imported = await trx
      .selectFrom("mercuryTransactionImport")
      .select("id")
      .where("id", "=", importId)
      .where("companyId", "=", companyId)
      .where("purchaseInvoiceId", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!imported)
      throw new MercuryImportError(
        "This payment is unavailable or already has an invoice"
      );
    const sources = await trx
      .selectFrom("invoiceIntakeSource")
      .select("intakeId")
      .where("companyId", "=", companyId)
      .where("mercuryImportId", "=", importId)
      .execute();
    const ids = [...new Set(sources.map((source) => source.intakeId))].sort();
    if (ids.length)
      await trx
        .selectFrom("invoiceIntake")
        .select("id")
        .where("companyId", "=", companyId)
        .where("id", "in", ids)
        .orderBy("id")
        .forUpdate()
        .execute();
    await trx
      .updateTable("mercuryTransactionImport")
      .set({ reviewStatus, updatedBy: userId, updatedAt: sql<string>`now()` })
      .where("id", "=", importId)
      .where("companyId", "=", companyId)
      .execute();
    if (ids.length) {
      let related = trx
        .updateTable("invoiceIntake")
        .set({
          status:
            reviewStatus === "Ignored"
              ? "Ignored"
              : sql<string>`CASE WHEN EXISTS (
          SELECT 1 FROM "invoiceIntakeSource" s WHERE s."companyId"="invoiceIntake"."companyId" AND s."intakeId"="invoiceIntake".id AND s."storagePath" IS NOT NULL
        ) THEN 'NeedsReview' ELSE 'NeedsDocument' END`,
          revision: sql<number>`revision+1`,
          updatedBy: userId,
          updatedAt: sql<string>`now()`
        })
        .where("companyId", "=", companyId)
        .where("id", "in", ids);
      related =
        reviewStatus === "Ignored"
          ? related.where("status", "not in", ["Approved", "Linked"])
          : related.where("status", "=", "Ignored");
      await related.execute();
    }
  });
}

/** Register local evidence for review without creating any supplier, item or invoice. */
export async function openMercuryInvoiceReview(
  db: Kysely<KyselyDatabase>,
  client: SupabaseClient<Database>,
  actor: { companyId: string; userId: string },
  importId: string
) {
  const { registerMercuryInvoiceSources } = await import(
    "@carbon/jobs/invoice-intake"
  );
  const registered = await registerMercuryInvoiceSources(
    { db, storage: client.storage, ...actor },
    importId
  );
  if (registered.needsDispatch) {
    try {
      const { trigger } = await import("@carbon/jobs");
      await trigger("invoice-intake", {
        companyId: actor.companyId,
        intakeId: registered.intakeId,
        generation: registered.generation
      });
    } catch {
      /* Durable queue reconciliation retries delivery without repeating approval. */
    }
  }
  return registered;
}

/** Explicit read-only bank/mailbox refresh. Credentials never leave this server helper. */
export async function refreshMercuryInvoiceDocuments(
  db: Kysely<KyselyDatabase>,
  client: SupabaseClient<Database>,
  actor: { companyId: string; userId: string },
  importId: string
) {
  const connection = getMercuryConnectionStatus(actor.companyId);
  if (!connection.mercuryReady)
    throw new MercuryImportError(
      "Configure the Mercury connection before refreshing documents"
    );
  const {
    refreshMercurySupportingDocuments,
    MercuryClient,
    parseGmailAccounts
  } = await import("@carbon/jobs/invoice-intake");
  let mailboxes: ReturnType<typeof parseGmailAccounts> = [];
  let gmailConfigError: string | undefined;
  try {
    mailboxes = parseGmailAccounts(optionalSecret("GMAIL_ACCOUNTS_JSON"));
  } catch {
    gmailConfigError = "gmail_configuration_invalid";
  }
  try {
    const refreshed = await refreshMercurySupportingDocuments(
      {
        db,
        storage: client.storage,
        companyId: actor.companyId,
        mercury: new MercuryClient(optionalSecret("MERCURY_API_TOKEN")!),
        mailboxes,
        gmailConfigError
      },
      actor.userId,
      importId
    );
    if (refreshed.state === "busy")
      throw new MercuryImportError(
        "A payment sync is already running. Try refreshing documents after it finishes."
      );
    if (refreshed.state === "disabled")
      throw new MercuryImportError(
        "Enable payment sync before refreshing Mercury and Gmail documents."
      );
    return {
      ...(await openMercuryInvoiceReview(db, client, actor, importId)),
      refreshState: refreshed.state
    };
  } catch (error) {
    if (error instanceof MercuryImportError) throw error;
    throw new MercuryImportError(
      "Unable to refresh supporting documents. Check the read-only Mercury and Gmail connections, then retry."
    );
  }
}

export async function approveMercuryReview(
  db: Kysely<KyselyDatabase>,
  client: SupabaseClient<Database>,
  input: MercuryApprovalInput
) {
  const result = await approveMercuryImport(db, input);
  let attachmentError = false;
  let intakeId: string | undefined;
  try {
    const registered = await openMercuryInvoiceReview(
      db,
      client,
      input,
      input.importId
    );
    intakeId = registered.intakeId;
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
  return { invoiceId: result.invoiceId, intakeId, attachmentError };
}
