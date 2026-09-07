import { createHash } from "node:crypto";
import type { Database } from "@carbon/database";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import {
  isMercuryAttachmentPath,
  lockCompanyInvoiceApproval,
  parseMercuryAttachments
} from "@carbon/database/mercury";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import { INVOICE_LIMITS, type InvoiceActor } from "./contracts";
import {
  assertInvoiceSourceAccess,
  InvoiceSourceError,
  registerInvoiceSource,
  validateInvoiceSourceBytes
} from "./ingestion";

type DatabaseClient = Kysely<KyselyDatabase>;
type Context = {
  db: DatabaseClient;
  storage: SupabaseClient<Database>["storage"];
  companyId: string;
  userId: string;
};
type Cursor = { createdAt: string; id: string };
type Counts = {
  processed: number;
  documents: number;
  needsDocument: number;
  linked: number;
  ignored: number;
};
const emptyCounts = (): Counts => ({
  processed: 0,
  documents: 0,
  needsDocument: 0,
  linked: 0,
  ignored: 0
});

function parseCursor(value: unknown): Cursor | null {
  if (!value || typeof value !== "object") return null;
  const cursor = value as Partial<Cursor>;
  return typeof cursor.createdAt === "string" && typeof cursor.id === "string"
    ? (cursor as Cursor)
    : null;
}
function parseCounts(value: unknown): Counts {
  const result = emptyCounts();
  if (value && typeof value === "object")
    for (const key of Object.keys(result) as (keyof Counts)[]) {
      const count = (value as Record<string, unknown>)[key];
      if (
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0
      )
        result[key] = count;
    }
  return result;
}

export async function controlInvoiceIntakeBackfill(
  db: DatabaseClient,
  actor: InvoiceActor,
  action: "start" | "pause" | "resume"
) {
  if (!["start", "pause", "resume"].includes(action))
    throw new InvoiceSourceError("invoice_backfill_action_invalid");
  await assertInvoiceSourceAccess(db, actor);
  return db.transaction().execute(async (trx) => {
    await assertInvoiceSourceAccess(trx, actor);
    const permission = await sql<{
      allowed: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM public."userPermission" WHERE id=${actor.userId}
      AND permissions->'settings_update' @> ${JSON.stringify([actor.companyId])}::jsonb) AS allowed`.execute(
      trx
    );
    if (!permission.rows[0]?.allowed)
      throw new InvoiceSourceError("invoice_backfill_access_denied");
    await trx
      .insertInto("invoiceIntakeSettings")
      .values({ companyId: actor.companyId, createdBy: actor.userId })
      .onConflict((oc) => oc.column("companyId").doNothing())
      .execute();
    const settings = await trx
      .selectFrom("invoiceIntakeSettings")
      .select(["backfillStatus", "backfillUpperBound"])
      .where("companyId", "=", actor.companyId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const restart =
      action === "start" &&
      (!settings.backfillUpperBound ||
        !["Running", "Paused", "Failed"].includes(settings.backfillStatus));
    if (action === "resume" && !settings.backfillUpperBound)
      throw new InvoiceSourceError("invoice_backfill_not_started");
    return trx
      .updateTable("invoiceIntakeSettings")
      .set({
        backfillStatus: action === "pause" ? "Paused" : "Running",
        updatedBy: actor.userId,
        updatedAt: sql<string>`now()`,
        lastErrorCode: null,
        ...(restart
          ? {
              backfillUpperBound: sql<string>`now()`,
              backfillCursor: null,
              backfillCounts: JSON.stringify(emptyCounts())
            }
          : {})
      })
      .where("companyId", "=", actor.companyId)
      .returning(["backfillStatus", "backfillCounts"])
      .executeTakeFirstOrThrow();
  });
}

/** Identities are stable across historical import, hourly refresh, and retries. */
export async function registerMercuryInvoiceSources(
  context: Context,
  importId: string,
  historical = false
) {
  const record = await context.db
    .selectFrom("mercuryTransactionImport")
    .select(["id", "attachments"])
    .where("companyId", "=", context.companyId)
    .where("id", "=", importId)
    .executeTakeFirst();
  if (!record)
    throw new InvoiceSourceError("invoice_source_import_unavailable");
  const actor = { companyId: context.companyId, userId: context.userId };
  let result = await registerInvoiceSource(context.db, context.storage, actor, {
    kind: "mercury",
    sourceKey: `payment:${record.id}`,
    mercuryImportId: record.id,
    historical
  });
  const savedAttachments = parseMercuryAttachments(record.attachments);
  const attachments = savedAttachments.filter(
    (attachment) =>
      attachment.source === "mercury" && attachment.current !== false
  );
  // Archive membership, never original bytes or approved document copies. Serialize
  // with approval and verify the same provider snapshot before changing eligibility.
  await context.db.transaction().execute(async (trx) => {
    await lockCompanyInvoiceApproval(trx, context.companyId);
    const fresh = await trx
      .selectFrom("mercuryTransactionImport")
      .select("attachments")
      .where("companyId", "=", context.companyId)
      .where("id", "=", importId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      JSON.stringify(parseMercuryAttachments(fresh.attachments)) !==
      JSON.stringify(savedAttachments)
    )
      throw new InvoiceSourceError("invoice_source_changed");
    const currentPaths = new Set(
      attachments.map((attachment) => attachment.path)
    );
    const oldSources = await trx
      .selectFrom("invoiceIntakeSource")
      .select(["id", "intakeId", "storagePath", "provenance"])
      .where("companyId", "=", context.companyId)
      .where("mercuryImportId", "=", importId)
      .where("kind", "=", "mercury")
      .where("storagePath", "is not", null)
      .execute();
    const changes = oldSources.flatMap((source) => {
      const metadata =
        source.provenance &&
        typeof source.provenance === "object" &&
        !Array.isArray(source.provenance)
          ? source.provenance
          : {};
      const current = currentPaths.has(source.storagePath!);
      return (metadata.current !== false) === current
        ? []
        : [{ id: source.id, intakeId: source.intakeId, current }];
    });
    if (!changes.length) return;
    const intakeIds = [...new Set(changes.map((change) => change.intakeId))];
    await trx
      .selectFrom("invoiceIntake")
      .select("id")
      .where("companyId", "=", context.companyId)
      .where("id", "in", intakeIds)
      .orderBy("id")
      .forUpdate()
      .execute();
    await sql`UPDATE public."invoiceIntakeSource" s SET provenance=coalesce(s.provenance,'{}'::jsonb)||jsonb_build_object('current',x.current),"updatedBy"=${context.userId},"updatedAt"=now()
      FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) AS x(id text,current boolean)
      WHERE s."companyId"=${context.companyId} AND s.id=x.id`.execute(trx);
    await sql`UPDATE public."invoiceIntake" i SET revision=revision+1,"updatedAt"=now(),"updatedBy"=${context.userId},
      status=CASE WHEN EXISTS(SELECT 1 FROM public."invoiceIntakeSource" s WHERE s."companyId"=i."companyId" AND s."intakeId"=i.id AND s."storagePath" IS NOT NULL AND s.sha256 IS NOT NULL AND (s.kind='upload' OR (s.kind='mercury' AND coalesce(s.provenance->>'current','true')<>'false'))) THEN 'NeedsReview' ELSE 'NeedsDocument' END,
      "activeExtractionId"=CASE WHEN status='Processing' THEN NULL ELSE "activeExtractionId" END,"lastErrorCode"='invoice_source_changed'
      WHERE i."companyId"=${context.companyId} AND i.id IN (${sql.join(intakeIds)}) AND i.status NOT IN ('Approved','Linked','Ignored')`.execute(
      trx
    );
  });
  if (attachments.length > 100)
    throw new InvoiceSourceError("invoice_source_attachment_limit");
  // Only directly attached Mercury receipts enter this collector. Existing Gmail
  // candidates remain stored for a future review of email matching.
  const sha256s = new Set<string>();
  const cachedFiles = new Map<string, Blob>();
  let cachedBytes = 0;
  for (const attachment of attachments) {
    if (!isMercuryAttachmentPath(context.companyId, attachment.path))
      throw new InvoiceSourceError("invoice_source_attachment_unavailable");
    const cached = cachedFiles.get(attachment.path);
    const downloaded = cached
      ? { data: cached, error: null }
      : await context.storage.from("private").download(attachment.path);
    if (downloaded.error || !downloaded.data)
      throw new InvoiceSourceError("invoice_source_attachment_unavailable");
    if (downloaded.data.size > INVOICE_LIMITS.pdfBytes)
      throw new InvoiceSourceError("invoice_source_size_invalid");
    const verified = validateInvoiceSourceBytes(
      new Uint8Array(await downloaded.data.arrayBuffer())
    );
    sha256s.add(verified.sha256);
    if (
      !cached &&
      cachedBytes + downloaded.data.size <= 2 * INVOICE_LIMITS.pdfBytes
    ) {
      cachedFiles.set(attachment.path, downloaded.data);
      cachedBytes += downloaded.data.size;
    }
  }
  const storage = {
    from: (bucket: string) => {
      const original = context.storage.from(bucket);
      return {
        upload: original.upload?.bind(original),
        download: (path: string) => {
          const data = bucket === "private" ? cachedFiles.get(path) : undefined;
          return data
            ? Promise.resolve({ data, error: null })
            : original.download(path);
        }
      };
    }
  } as Context["storage"];
  const mercuryDocumentSet = {
    attachments: JSON.stringify(savedAttachments),
    sha256s: [...sha256s]
  };
  for (const attachment of attachments) {
    // The source reader verifies the path, source kind and bytes against the saved
    // import again. No provider URLs, mailbox credential, or model input is trusted here.
    const identity = JSON.stringify([
      record.id,
      attachment.path,
      attachment.mailbox ?? "",
      attachment.messageId ?? ""
    ]);
    result = await registerInvoiceSource(context.db, storage, actor, {
      kind: attachment.source,
      sourceKey: `attachment:${createHash("sha256").update(identity).digest("hex")}`,
      mercuryImportId: record.id,
      storagePath: attachment.path,
      historical,
      mercuryDocumentSet
    });
  }
  const final = await context.db
    .selectFrom("invoiceIntake")
    .select(["status", "generation"])
    .where("companyId", "=", context.companyId)
    .where("id", "=", result.intakeId)
    .executeTakeFirstOrThrow();
  return {
    ...result,
    ...final,
    needsDispatch: final.status === "Queued",
    documents: attachments.length
  };
}

/** Local, resumable bridge. Paid inference is dispatched independently by reconciliation. */
export async function runInvoiceIntakeBackfillPage(
  context: Context
): Promise<{ state: string; processed: number; needsMore: boolean }> {
  return context.db.connection().execute(async (connection) => {
    const lock = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_lock(hashtext('invoice-intake-backfill'),hashtext(${context.companyId})) AS locked`.execute(
      connection
    );
    if (!lock.rows[0]?.locked)
      return { state: "busy", processed: 0, needsMore: false };
    try {
      const settings = await connection
        .selectFrom("invoiceIntakeSettings")
        .selectAll()
        .select(
          sql<string | null>`"backfillUpperBound"::text`.as(
            "backfillUpperBound"
          )
        )
        .where("companyId", "=", context.companyId)
        .executeTakeFirst();
      if (
        !settings ||
        settings.backfillStatus !== "Running" ||
        !settings.backfillUpperBound
      )
        return { state: "paused", processed: 0, needsMore: false };
      const actor = settings.updatedBy || settings.createdBy;
      // Stale events cannot replace the current initiating operator.
      if (context.userId !== actor)
        return { state: "stale", processed: 0, needsMore: false };
      await assertInvoiceSourceAccess(connection, {
        companyId: context.companyId,
        userId: actor
      });
      const cursor = parseCursor(settings.backfillCursor);
      const counts = parseCounts(settings.backfillCounts);
      const records =
        await sql<Cursor>`SELECT id,"createdAt"::text AS "createdAt" FROM public."mercuryTransactionImport"
        WHERE "companyId"=${context.companyId} AND "createdAt"<=${settings.backfillUpperBound}::timestamptz
        ${cursor ? sql`AND ("createdAt",id)>(${cursor.createdAt}::timestamptz,${cursor.id})` : sql``}
        ORDER BY "createdAt",id LIMIT 100`.execute(connection);
      let processed = 0;
      for (const record of records.rows) {
        const live = await connection
          .selectFrom("invoiceIntakeSettings")
          .select(["backfillStatus", "updatedBy", "createdBy"])
          .where("companyId", "=", context.companyId)
          .executeTakeFirstOrThrow();
        if (
          live.backfillStatus !== "Running" ||
          (live.updatedBy || live.createdBy) !== actor
        )
          return { state: "paused", processed, needsMore: false };
        const registered = await registerMercuryInvoiceSources(
          { ...context, db: connection, userId: actor },
          record.id,
          true
        );
        counts.processed++;
        counts.documents += registered.documents;
        if (registered.status === "NeedsDocument") counts.needsDocument++;
        if (registered.status === "Linked") counts.linked++;
        if (registered.status === "Ignored") counts.ignored++;
        // Each cursor follows committed identities. A crash before this write only
        // replays idempotent registration; a failed source never skips its payment.
        await connection
          .updateTable("invoiceIntakeSettings")
          .set({
            backfillCursor: JSON.stringify(record),
            backfillCounts: JSON.stringify(counts)
          })
          .where("companyId", "=", context.companyId)
          .execute();
        processed++;
      }
      const needsMore = records.rows.length === 100;
      if (!needsMore)
        await connection
          .updateTable("invoiceIntakeSettings")
          .set({ backfillStatus: "Completed", lastErrorCode: null })
          .where("companyId", "=", context.companyId)
          .where("backfillStatus", "=", "Running")
          .execute();
      return {
        state: needsMore ? "Running" : "Completed",
        processed,
        needsMore
      };
    } catch (error) {
      await connection
        .updateTable("invoiceIntakeSettings")
        .set({
          backfillStatus: "Failed",
          lastErrorCode:
            error instanceof InvoiceSourceError
              ? error.message
              : "invoice_backfill_failed"
        })
        .where("companyId", "=", context.companyId)
        .where("backfillStatus", "=", "Running")
        .execute();
      return { state: "Failed", processed: 0, needsMore: false };
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext('invoice-intake-backfill'),hashtext(${context.companyId}))`.execute(
        connection
      );
    }
  });
}

/** Failure here cannot roll back committed bank evidence or its independent cursors. */
export async function registerAutomaticMercuryInvoiceSources(
  context: Context,
  importIds: string[]
) {
  const settings = await context.db
    .selectFrom("invoiceIntakeSettings")
    .select("automaticMercuryIntake")
    .where("companyId", "=", context.companyId)
    .executeTakeFirst();
  if (!settings?.automaticMercuryIntake) return;
  for (const id of new Set(importIds)) {
    try {
      await registerMercuryInvoiceSources(context, id);
    } catch {
      await context.db
        .updateTable("invoiceIntakeSettings")
        .set({ lastErrorCode: "invoice_automatic_registration_failed" })
        .where("companyId", "=", context.companyId)
        .execute();
    }
  }
}

/** Retry missing local bridges after the operator enabled automatic intake. */
export async function reconcileMercuryInvoiceSources(
  context: Omit<Context, "userId">
) {
  const settings = await context.db
    .selectFrom("invoiceIntakeSettings")
    .select(["automaticMercuryIntake", "createdAt", "updatedBy", "createdBy"])
    .select(sql<string>`"createdAt"::text`.as("createdAt"))
    .where("companyId", "=", context.companyId)
    .executeTakeFirst();
  if (!settings?.automaticMercuryIntake) return { processed: 0 };
  const records = await context.db
    .selectFrom("mercuryTransactionImport as m")
    .select("m.id")
    .where("m.companyId", "=", context.companyId)
    .where((eb) =>
      eb.or([
        eb("m.createdAt", ">=", settings.createdAt),
        eb("m.updatedAt", ">=", settings.createdAt)
      ])
    )
    .where(sql<boolean>`(NOT EXISTS (SELECT 1 FROM public."invoiceIntakeSource" s
      WHERE s."companyId"=m."companyId" AND s."mercuryImportId"=m.id AND s.kind='mercury' AND s."storagePath" IS NULL)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments)='array' THEN m.attachments ELSE '[]'::jsonb END) a
        WHERE a->>'source'='mercury' AND coalesce(a->>'current','true')<>'false' AND NOT EXISTS(SELECT 1 FROM public."invoiceIntakeSource" s WHERE s."companyId"=m."companyId"
          AND s."mercuryImportId"=m.id AND s."storagePath"=a->>'path' AND s.kind=a->>'source' AND coalesce(s.provenance->>'current','true')<>'false'))
      OR EXISTS(SELECT 1 FROM public."invoiceIntakeSource" s WHERE s."companyId"=m."companyId" AND s."mercuryImportId"=m.id AND s.kind='mercury' AND s."storagePath" IS NOT NULL AND coalesce(s.provenance->>'current','true')<>'false' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments)='array' THEN m.attachments ELSE '[]'::jsonb END) a WHERE a->>'source'='mercury' AND coalesce(a->>'current','true')<>'false' AND a->>'path'=s."storagePath")))`)
    .orderBy("m.createdAt")
    .orderBy("m.id")
    .limit(100)
    .execute();
  await registerAutomaticMercuryInvoiceSources(
    { ...context, userId: settings.updatedBy || settings.createdBy },
    records.map((row) => row.id)
  );
  return { processed: records.length };
}
