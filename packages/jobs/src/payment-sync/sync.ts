import { createHash } from "node:crypto";
import type { Database } from "@carbon/database";
import {
  type MercuryAttachment,
  type MercuryInvoiceEvidence,
  type MercuryReceiptAcquisition,
  type MercurySyncSettings,
  parseMercuryAttachments,
  parseMercuryInvoiceEvidence,
  parseMercuryVendorSuggestion
} from "@carbon/database/mercury";
import { datetime } from "@carbon/utils";
import { parseAbsolute } from "@internationalized/date";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import type { JobDatabase } from "../db";
import { registerAutomaticMercuryInvoiceSources } from "../invoice-intake/backfill";
import { assertInvoiceSourceAccess } from "../invoice-intake/ingestion";
import {
  type InvoiceCandidate,
  isOutgoingPayment,
  normalizedAmount,
  rankInvoiceCandidates
} from "./matching";
import {
  GmailClient,
  type GmailMailboxConfig,
  type MercuryClient,
  type PaymentSource,
  ProviderError
} from "./providers";

type Context = {
  db: JobDatabase;
  storage: SupabaseClient<Database>["storage"];
  companyId: string;
  mercury: MercuryClient;
  mailboxes: GmailMailboxConfig[];
  gmailClients?: GmailClient[];
  gmailConfigError?: string;
};
type Result = {
  state: "disabled" | "busy" | "complete" | "backfill";
  imported: number;
  refreshed: number;
};

class SyncPaused extends Error {
  constructor() {
    super("sync_paused");
    this.name = "PaymentSyncPaused";
  }
}

export function providerErrorCode(error: unknown): string {
  return error instanceof ProviderError
    ? `${error.provider.toLowerCase()}_${error.code}${error.status ? `_${error.status}` : ""}`
    : "sync_failed";
}

function fileType(
  bytes: Uint8Array
): { extension: string; contentType: string } | null {
  if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-")
    return { extension: "pdf", contentType: "application/pdf" };
  if (
    bytes[0] === 0x89 &&
    new TextDecoder().decode(bytes.slice(1, 4)) === "PNG"
  )
    return { extension: "png", contentType: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { extension: "jpg", contentType: "image/jpeg" };
  return null;
}

/** One stored object may independently arrive from the bank and an email. */
function attachmentIdentity(attachment: MercuryAttachment): string {
  return JSON.stringify([
    attachment.source,
    attachment.path,
    attachment.mailbox ?? "",
    attachment.messageId ?? ""
  ]);
}

/** Content-addressed names make storage retries harmless without storing signed URLs. */
export async function storeAttachment(
  context: Pick<Context, "storage" | "companyId">,
  transactionId: string,
  fileName: string,
  bytes: Uint8Array,
  source: Pick<MercuryAttachment, "source" | "mailbox" | "messageId">
): Promise<MercuryAttachment> {
  const type = fileType(bytes);
  if (!type || bytes.length > 10 * 1024 * 1024)
    throw new ProviderError("Attachment", "unsupported_file");
  const transaction = createHash("sha256").update(transactionId).digest("hex");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = `${context.companyId}/mercury/${transaction}/${digest}.${type.extension}`;
  const { error } = await context.storage
    .from("private")
    .upload(path, bytes, { contentType: type.contentType, upsert: true });
  if (error) throw new Error("attachment_storage_failed");
  return {
    path,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize untrusted document filenames.
    fileName: fileName.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 200),
    ...source
  };
}

async function settings(
  context: Context
): Promise<MercurySyncSettings | undefined> {
  return await context.db
    .selectFrom("mercurySyncSettings")
    .selectAll()
    .select(sql<string | null>`"syncFromDate"::text`.as("syncFromDate"))
    .select(sql<string | null>`"updatedAt"::text`.as("updatedAt"))
    .where("companyId", "=", context.companyId)
    .executeTakeFirst();
}

async function assertOperator(context: Context, current: MercurySyncSettings) {
  const employee = await context.db
    .selectFrom("employee")
    .innerJoin("user", "user.id", "employee.id")
    .innerJoin("userPermission", "userPermission.id", "employee.id")
    .innerJoin("userToCompany", (join) =>
      join
        .onRef("userToCompany.userId", "=", "employee.id")
        .onRef("userToCompany.companyId", "=", "employee.companyId")
    )
    .select("employee.id")
    .where("employee.companyId", "=", context.companyId)
    .where("employee.id", "=", current.updatedBy || current.createdBy)
    .where("employee.active", "=", true)
    .where("user.active", "=", true)
    .where("userToCompany.role", "=", "employee")
    .where(
      sql<boolean>`("userPermission"."permissions"->'invoicing_view' @> ${JSON.stringify([context.companyId])}::jsonb OR "userPermission"."permissions"->'invoicing_view' @> '["0"]'::jsonb)`
    )
    .executeTakeFirst();
  if (!employee) throw new Error("sync_operator_unavailable");
}

async function assertActive(context: Context, current: MercurySyncSettings) {
  const live = await settings(context);
  if (
    !live?.enabled ||
    live.updatedAt !== current.updatedAt ||
    live.gmailEnabled !== current.gmailEnabled ||
    JSON.stringify(live.disabledMailboxes) !==
      JSON.stringify(current.disabledMailboxes)
  )
    throw new SyncPaused();
  await assertOperator(context, live);
}

function createActiveGuard(context: Context, current: MercurySyncSettings) {
  // Check controls at most once per second, independent of the number of
  // records. Page boundaries and commit still perform an exact check.
  let checkedAt = -Infinity;
  let check: Promise<void> | undefined;
  return async (force = false) => {
    if (!force && performance.now() - checkedAt < 1000 && check) return check;
    checkedAt = performance.now();
    check = assertActive(context, current);
    return check;
  };
}

async function processPage(
  context: Context,
  payments: PaymentSource[],
  current: MercurySyncSettings,
  cursors: { cursor?: string; eventCursor?: string } = {},
  assertPageActive = createActiveGuard(context, current),
  findDocumentAgain = false
) {
  await assertPageActive(true);
  if (
    payments.some(
      (payment) =>
        normalizedAmount(payment.amount) === null ||
        !Number.isFinite(Number(payment.amount)) ||
        Math.abs(Number(payment.amount)) > Number.MAX_SAFE_INTEGER / 100
    )
  ) {
    throw new ProviderError("Mercury", "invalid_amount");
  }
  const discovered = [
    ...new Map(
      payments.filter(isOutgoingPayment).map((payment) => [payment.id, payment])
    ).values()
  ];
  const ids = discovered.map((payment) => payment.id);
  const existing = ids.length
    ? await context.db
        .selectFrom("mercuryTransactionImport")
        .select([
          "mercuryTransactionId",
          "attachments",
          "invoiceEvidence",
          "vendorSuggestion",
          "reviewStatus"
        ])
        .where("companyId", "=", context.companyId)
        .where("mercuryTransactionId", "in", ids)
        .execute()
    : [];
  const prior = new Map(existing.map((row) => [row.mercuryTransactionId, row]));
  // Mercury's history filter uses creation time. Events can mention older
  // transactions: keep refreshing known rows, but do not import excluded history.
  const historyStart = current.syncFromDate
    ? parseAbsolute(`${current.syncFromDate}T00:00:00Z`, "UTC")
    : null;
  const outgoing = discovered.filter((payment) => {
    if (!historyStart || prior.has(payment.id)) return true;
    try {
      return parseAbsolute(payment.createdAt, "UTC").compare(historyStart) >= 0;
    } catch {
      throw new ProviderError("Mercury", "invalid_created_at");
    }
  });
  const mailboxes = current.gmailEnabled
    ? context.mailboxes.filter(
        (mailbox) =>
          mailbox.enabled && !current.disabledMailboxes.includes(mailbox.email)
      )
    : [];
  const gmail = (
    context.gmailClients || mailboxes.map((mailbox) => new GmailClient(mailbox))
  ).filter((client) =>
    mailboxes.some((mailbox) => mailbox.email === client.config.email)
  );
  for (const client of gmail) client.options.beforeRequest = assertPageActive;
  const recipientIds = [
    ...new Set(
      outgoing
        .map((payment) => payment.recipientId)
        .filter((id): id is string => !!id)
    )
  ];
  const recipients = new Map<
    string,
    Awaited<ReturnType<MercuryClient["getRecipient"]>>
  >();
  for (const id of recipientIds) {
    await assertPageActive();
    try {
      recipients.set(id, await context.mercury.getRecipient(id));
    } catch (error) {
      if (error instanceof SyncPaused) throw error;
      /* Keep the transaction's name and show a draft for review. */
    }
  }
  let gmailError: string | null = context.gmailConfigError || null;
  const rows: Database["public"]["Tables"]["mercuryTransactionImport"]["Insert"][] =
    [];
  for (const transaction of outgoing) {
    await assertPageActive();
    const old = prior.get(transaction.id);
    const recipient = transaction.recipientId
      ? recipients.get(transaction.recipientId)
      : undefined;
    const payment = {
      ...transaction,
      name: recipient?.name || transaction.name,
      email: recipient?.email || transaction.email
    };
    let issue: string | null = null;
    const attachments = new Map(
      parseMercuryAttachments(old?.attachments).map((attachment) => [
        attachmentIdentity(attachment),
        attachment
      ])
    );
    const mercuryReceiptAcquisition: MercuryReceiptAcquisition = {
      attachmentCount: payment.attachments.length,
      hasGeneratedReceipt: payment.hasGeneratedReceipt ?? null,
      checkedAt: datetime.timestamp(),
      attachments: []
    };
    for (const attachment of payment.attachments.slice(0, 10)) {
      try {
        await assertPageActive();
        const bytes = await context.mercury.downloadAttachment(attachment);
        await assertPageActive();
        const saved = await storeAttachment(
          context,
          payment.id,
          attachment.fileName,
          bytes,
          { source: "mercury" }
        );
        attachments.set(attachmentIdentity(saved), saved);
        mercuryReceiptAcquisition.attachments.push({
          id: attachment.id,
          fileName: attachment.fileName,
          status: "saved",
          path: saved.path
        });
      } catch (error) {
        if (error instanceof SyncPaused) throw error;
        issue = providerErrorCode(error);
        mercuryReceiptAcquisition.attachments.push({
          id: attachment.id,
          fileName: attachment.fileName,
          status:
            issue === "attachment_unsupported_file"
              ? "unsupported"
              : "unavailable",
          errorCode: issue
        });
      }
    }
    mercuryReceiptAcquisition.attachments.push(
      ...payment.attachments.slice(10, 100).map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        status: "limit" as const,
        errorCode: "attachment_limit_review_required"
      }))
    );
    if (payment.attachments.length > 10)
      issue = "attachment_limit_review_required";
    const candidates: InvoiceCandidate[] = [];
    let incomplete = !!context.gmailConfigError;
    // Already-approved records retain their reviewed evidence. New or unresolved
    // payments are revisited, so a later invoice email can still be discovered.
    if (!old || old.reviewStatus === "Pending" || findDocumentAgain) {
      for (const mailbox of gmail) {
        try {
          const found = await mailbox.searchInvoices(payment);
          candidates.push(...found.candidates);
          if (found.truncated) {
            incomplete = true;
            issue = "gmail_search_truncated_review_required";
          }
        } catch (error) {
          if (error instanceof SyncPaused) throw error;
          incomplete = true;
          gmailError = providerErrorCode(error);
        }
      }
    }
    const ranked = rankInvoiceCandidates(payment, candidates);
    if (incomplete) ranked.best = null;
    // Unrelated personal invoices returned by a broad amount query are not
    // copied to company storage. A score above 59 requires vendor evidence.
    ranked.candidates = ranked.candidates.filter(
      (candidate) => candidate.score >= 60
    );
    const evidence: MercuryInvoiceEvidence[] = ranked.candidates
      .slice(0, 5)
      .map(({ mailbox, messageId, subject, from, date, score, reasons }) => ({
        mailbox,
        messageId,
        subject,
        from,
        date,
        score,
        reasons
      }));
    if (ranked.ambiguous) issue = "multiple_invoice_matches_review_required";
    for (const candidate of ranked.candidates.slice(0, 3)) {
      const mailbox = gmail.find(
        (client) => client.config.email === candidate.mailbox
      );
      if (!mailbox) continue;
      for (const attachment of candidate.attachments.slice(0, 3)) {
        try {
          await assertPageActive();
          const bytes = await mailbox.getAttachment(candidate, attachment);
          await assertPageActive();
          const saved = await storeAttachment(
            context,
            payment.id,
            attachment.fileName,
            bytes,
            {
              source: "gmail",
              mailbox: candidate.mailbox,
              messageId: candidate.messageId
            }
          );
          attachments.set(attachmentIdentity(saved), saved);
        } catch (error) {
          if (error instanceof SyncPaused) throw error;
          issue = providerErrorCode(error);
        }
      }
    }
    const suggestion = {
      name: payment.name || ranked.best?.suggestedVendor.name || "",
      email: payment.email || ranked.best?.suggestedVendor.email || null,
      source: ranked.best
        ? "Mercury and Gmail invoice evidence"
        : "Mercury recipient",
      reason: ranked.best
        ? ranked.best.reasons.join("; ")
        : "Review the recipient and invoice before creating a supplier."
    };
    rows.push({
      companyId: context.companyId,
      mercuryTransactionId: payment.id,
      mercuryAccountId: payment.accountId,
      mercuryRecipientId: payment.recipientId,
      remoteStatus: payment.status,
      amount: Number(payment.amount.replace(/^-/, "")),
      currencyCode: payment.currency,
      transactionDate: payment.postedAt || payment.createdAt,
      reference: null,
      memo: payment.note,
      vendorSuggestion: {
        ...(old?.reviewStatus === "Imported"
          ? parseMercuryVendorSuggestion(old.vendorSuggestion)
          : suggestion),
        mercuryReceiptAcquisition
      },
      invoiceEvidence: JSON.stringify([
        ...new Map(
          [
            ...parseMercuryInvoiceEvidence(old?.invoiceEvidence),
            ...evidence
          ].map((entry) => [`${entry.mailbox}:${entry.messageId}`, entry])
        ).values()
      ]),
      attachments: JSON.stringify([...attachments.values()]),
      lastError: issue,
      createdBy: current.updatedBy || current.createdBy,
      updatedAt: datetime.timestamp()
    });
  }
  const committed = await context.db.transaction().execute(async (trx) => {
    const live = await trx
      .selectFrom("mercurySyncSettings")
      .selectAll()
      .select(sql<string | null>`"updatedAt"::text`.as("updatedAt"))
      .where("companyId", "=", context.companyId)
      .forUpdate()
      .executeTakeFirst();
    if (!live?.enabled) return { stopped: true, count: 0 };
    // A settings change during remote reads is retried using the new controls.
    if (
      live.updatedAt !== current.updatedAt ||
      live.gmailEnabled !== current.gmailEnabled ||
      JSON.stringify(live.disabledMailboxes) !==
        JSON.stringify(current.disabledMailboxes)
    )
      return { stopped: true, count: 0 };
    await assertOperator({ ...context, db: trx }, current);
    if (rows.length)
      await trx
        .insertInto("mercuryTransactionImport")
        .values(rows)
        .onConflict((conflict) =>
          conflict
            .columns(["companyId", "mercuryTransactionId"])
            .doUpdateSet((eb) => ({
              remoteStatus: eb.ref("excluded.remoteStatus"),
              amount: eb.ref("excluded.amount"),
              transactionDate: eb.ref("excluded.transactionDate"),
              memo: eb.ref("excluded.memo"),
              attachments: eb.ref("excluded.attachments"),
              invoiceEvidence: eb.ref("excluded.invoiceEvidence"),
              vendorSuggestion: sql`CASE WHEN "mercuryTransactionImport"."reviewStatus" = 'Imported' THEN coalesce("mercuryTransactionImport"."vendorSuggestion",'{}'::jsonb) || jsonb_build_object('mercuryReceiptAcquisition',excluded."vendorSuggestion"->'mercuryReceiptAcquisition') ELSE excluded."vendorSuggestion" END`,
              lastError: sql`CASE WHEN "mercuryTransactionImport"."lastError" = 'ATTACHMENT_COPY_FAILED' AND "mercuryTransactionImport"."reviewStatus" = 'Imported' THEN "mercuryTransactionImport"."lastError" ELSE excluded."lastError" END`,
              updatedAt: eb.ref("excluded.updatedAt")
            }))
        )
        .execute();
    await trx
      .updateTable("mercurySyncSettings")
      .set({ ...cursors, lastGmailError: gmailError })
      .where("companyId", "=", context.companyId)
      .execute();
    return { stopped: false, count: rows.length };
  });
  if (!committed.stopped && rows.length) {
    // The bank page and its cursor are already committed. Inference configuration,
    // source-registration errors and queue dispatch cannot fail the bank import.
    try {
      const saved = await context.db
        .selectFrom("mercuryTransactionImport")
        .select("id")
        .where("companyId", "=", context.companyId)
        .where(
          "mercuryTransactionId",
          "in",
          rows.map((row) => row.mercuryTransactionId)
        )
        .execute();
      await registerAutomaticMercuryInvoiceSources(
        { ...context, userId: current.updatedBy || current.createdBy },
        saved.map((row) => row.id)
      );
    } catch {
      /* The paginated local reconciler retries missing source registrations. */
    }
  }
  return committed;
}

/** Explicit read-only evidence search for an already reviewed payment. */
export async function refreshMercurySupportingDocuments(
  context: Context,
  userId: string,
  importId: string
) {
  await assertInvoiceSourceAccess(context.db, {
    companyId: context.companyId,
    userId
  });
  return context.db.connection().execute(async (connection) => {
    const locked = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_lock(hashtext('mercury-sync'),hashtext(${context.companyId})) AS locked`.execute(
      connection
    );
    if (!locked.rows[0]?.locked) return { state: "busy" };
    try {
      const scoped = { ...context, db: connection };
      const current = await settings(scoped);
      if (!current?.enabled) return { state: "disabled" };
      await assertOperator(scoped, current);
      const imported = await connection
        .selectFrom("mercuryTransactionImport")
        .select(["mercuryTransactionId", "reviewStatus"])
        .where("companyId", "=", context.companyId)
        .where("id", "=", importId)
        .executeTakeFirst();
      if (!imported || imported.reviewStatus === "Ignored")
        throw new Error("invoice_source_import_unavailable");
      const active = createActiveGuard(scoped, current);
      await active(true);
      const payment = await context.mercury.getTransaction(
        imported.mercuryTransactionId
      );
      const result = await processPage(
        scoped,
        [payment],
        current,
        {},
        active,
        true
      );
      return { state: result.stopped ? "disabled" : "complete" };
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext('mercury-sync'),hashtext(${context.companyId}))`.execute(
        connection
      );
    }
  });
}

/** One process-owned advisory lock also protects against manual/cron overlap. */
export async function runMercurySync(context: Context): Promise<Result> {
  return await context.db.connection().execute(async (connection) => {
    const locked = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_lock(hashtext('mercury-sync'), hashtext(${context.companyId})) AS locked`.execute(
      connection
    );
    if (!locked.rows[0]?.locked)
      return { state: "busy", imported: 0, refreshed: 0 };
    const scoped = {
      ...context,
      db: connection,
      gmailClients:
        context.gmailClients ||
        context.mailboxes.map((mailbox) => new GmailClient(mailbox))
    };
    try {
      let current = await settings(scoped);
      if (!current?.enabled)
        return { state: "disabled", imported: 0, refreshed: 0 };
      // Credentials belong to one configured company. The recorded operator must
      // still have active membership and permission when the job executes.
      await assertOperator(scoped, current);
      await connection
        .updateTable("mercurySyncSettings")
        .set({ lastAttemptAt: datetime.timestamp(), lastError: null })
        .where("companyId", "=", context.companyId)
        .execute();
      let imported = 0;
      let refreshed = 0;
      let more = false;
      // Bounded pages keep an initial multi-year backfill resumable. Each cursor
      // advances in the same transaction as its evidence, including empty pages.
      for (let page = 0; page < 4; page++) {
        current = await settings(scoped);
        if (!current?.enabled)
          return { state: "disabled", imported, refreshed };
        const checkActive = createActiveGuard(scoped, current);
        await checkActive();
        const found = await context.mercury.listTransactions({
          startAfter: current.cursor || undefined,
          start: current.syncFromDate || undefined,
          limit: 25
        });
        const last = found.payments.at(-1)?.id;
        const result = await processPage(
          scoped,
          found.payments,
          current,
          last ? { cursor: last } : {},
          checkActive
        );
        if (result.stopped) return { state: "disabled", imported, refreshed };
        imported += result.count;
        more = !!found.nextPage;
        if (!more) break;
      }
      // Events give every changed payment a refresh on the next hourly pass,
      // including a reversal of an old payment. The normal transaction history
      // and round-robin refresh remain available after the event retention window.
      for (let page = 0; page < 4; page++) {
        current = await settings(scoped);
        if (!current?.enabled)
          return { state: "disabled", imported, refreshed };
        const checkActive = createActiveGuard(scoped, current);
        await checkActive();
        let found: Awaited<ReturnType<MercuryClient["listEvents"]>>;
        try {
          found = await context.mercury.listEvents({
            startAfter: current.eventCursor || undefined,
            limit: 25
          });
        } catch (error) {
          if (
            error instanceof ProviderError &&
            error.status === 400 &&
            current.eventCursor
          ) {
            await connection
              .updateTable("mercurySyncSettings")
              .set({ eventCursor: null })
              .where("companyId", "=", context.companyId)
              .execute();
            more = true;
            break;
          }
          throw error;
        }
        const changed: PaymentSource[] = [];
        for (const id of new Set(
          found.events
            .filter(
              (event) =>
                event.resourceType === "transaction" &&
                event.operationType !== "delete"
            )
            .map((event) => event.resourceId)
        )) {
          // Explicit checks also cover injected clients and test doubles that
          // replace a provider method without its HTTP beforeRequest hook.
          await checkActive();
          try {
            changed.push(await context.mercury.getTransaction(id));
          } catch (error) {
            if (!(error instanceof ProviderError && error.status === 404))
              throw error;
          }
        }
        const eventCursor = found.events.at(-1)?.id;
        const result = await processPage(
          scoped,
          changed,
          current,
          eventCursor ? { eventCursor } : {},
          checkActive
        );
        if (result.stopped) return { state: "disabled", imported, refreshed };
        refreshed += result.count;
        if (!found.nextPage) break;
        if (page === 3) more = true;
      }
      // Round-robin refresh catches delayed receipts and status changes even if
      // Mercury's 90-day event history has expired after a long disconnection.
      const revisit = await connection
        .selectFrom("mercuryTransactionImport")
        .select("mercuryTransactionId")
        .where("companyId", "=", context.companyId)
        .where("reviewStatus", "!=", "Ignored")
        .orderBy("updatedAt", "asc")
        .limit(10)
        .execute();
      const updates: PaymentSource[] = [];
      const checkActive = createActiveGuard(scoped, current);
      for (const row of revisit) {
        await checkActive();
        try {
          updates.push(
            await context.mercury.getTransaction(row.mercuryTransactionId)
          );
        } catch (error) {
          if (!(error instanceof ProviderError && error.status === 404))
            throw error;
        }
      }
      await checkActive(true);
      if (updates.length) {
        const result = await processPage(
          scoped,
          updates,
          current,
          {},
          checkActive
        );
        if (result.stopped) return { state: "disabled", imported, refreshed };
        refreshed += result.count;
      }
      await connection
        .updateTable("mercurySyncSettings")
        .set({
          lastSuccessAt: datetime.timestamp(),
          lastError: more ? "history_import_in_progress" : null
        })
        .where("companyId", "=", context.companyId)
        .execute();
      return { state: more ? "backfill" : "complete", imported, refreshed };
    } catch (error) {
      if (error instanceof SyncPaused)
        return { state: "disabled", imported: 0, refreshed: 0 };
      await connection
        .updateTable("mercurySyncSettings")
        .set({ lastError: providerErrorCode(error) })
        .where("companyId", "=", context.companyId)
        .execute();
      throw new Error(providerErrorCode(error));
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext('mercury-sync'), hashtext(${context.companyId}))`.execute(
        connection
      );
    }
  });
}
