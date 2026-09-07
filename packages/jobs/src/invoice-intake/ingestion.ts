import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@carbon/database";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import {
  isMercuryAttachmentPath,
  lockCompanyInvoiceApproval,
  parseMercuryAttachments
} from "@carbon/database/mercury";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import {
  INVOICE_LIMITS,
  type InvoiceActor,
  invoiceSourceReviewSchema
} from "./contracts";

type InvoiceDatabase = Kysely<KyselyDatabase>;
type InvoiceStorage = SupabaseClient<Database>["storage"];
export class InvoiceSourceError extends Error {}

export type InvoiceSourceInput = {
  kind: "upload" | "mercury" | "gmail";
  sourceKey: string;
  fileName?: string;
  bytes?: Uint8Array;
  mercuryImportId?: string;
  storagePath?: string;
  existingIntakeId?: string;
  purchaseInvoiceId?: string;
  historical?: boolean;
  /** Collector-only snapshot of saved attachments and their verified byte hashes. */
  mercuryDocumentSet?: { attachments: string; sha256s: string[] };
};
export type RegisteredInvoiceSource = {
  intakeId: string;
  sourceId: string;
  existing: boolean;
  generation: number;
  status: string;
  needsDispatch: boolean;
};

/** Recheck the initiating employee before privileged financial-source reads. */
export async function assertInvoiceSourceAccess(
  db: InvoiceDatabase,
  actor: InvoiceActor
): Promise<void> {
  const result = await sql<{ allowed: boolean }>`SELECT EXISTS (
    SELECT 1 FROM public.employee e
    JOIN public."user" u ON u.id=e.id
    JOIN public."userToCompany" c ON c."userId"=e.id AND c."companyId"=e."companyId"
    JOIN public."userPermission" p ON p.id=e.id
    WHERE e.id=${actor.userId} AND e."companyId"=${actor.companyId}
      AND e.active AND u.active AND c.role='employee'
      AND p.permissions->'invoicing_view' @> ${JSON.stringify([actor.companyId])}::jsonb
      AND (p.permissions->'invoicing_create' @> ${JSON.stringify([actor.companyId])}::jsonb
        OR p.permissions->'invoicing_update' @> ${JSON.stringify([actor.companyId])}::jsonb)
  ) AS allowed`.execute(db);
  if (!result.rows[0]?.allowed)
    throw new InvoiceSourceError("invoice_source_access_denied");
}

export function isInvoiceSourcePath(companyId: string, path: string): boolean {
  return (
    path.startsWith(`${companyId}/invoice-intake/`) &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    Array.from(path).every(
      (character) =>
        character !== "\\" &&
        character.charCodeAt(0) >= 32 &&
        character.charCodeAt(0) !== 127
    )
  );
}

/** Declared browser MIME and extensions are never authority for document type. */
export function validateInvoiceSourceBytes(bytes: Uint8Array) {
  let mediaType: "application/pdf" | "image/png" | "image/jpeg";
  let extension: "pdf" | "png" | "jpg";
  if (Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-") {
    mediaType = "application/pdf";
    extension = "pdf";
  } else if (
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) {
    mediaType = "image/png";
    extension = "png";
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mediaType = "image/jpeg";
    extension = "jpg";
  } else throw new InvoiceSourceError("invoice_media_unsupported");
  if (
    bytes.length >
    (mediaType === "application/pdf"
      ? INVOICE_LIMITS.pdfBytes
      : INVOICE_LIMITS.imageBytes)
  ) {
    throw new InvoiceSourceError("invoice_source_size_invalid");
  }
  return {
    mediaType,
    extension,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length
  };
}

type SourceFile = ReturnType<typeof validateInvoiceSourceBytes> & {
  storagePath: string;
  fileName: string;
};
type MercuryRecord = {
  id: string;
  supplierId: string | null;
  purchaseInvoiceId: string | null;
  reviewStatus: string;
  attachments: unknown;
};

async function ownedMercury(
  db: InvoiceDatabase,
  actor: InvoiceActor,
  input: InvoiceSourceInput,
  lock = false
) {
  if (!input.mercuryImportId)
    throw new InvoiceSourceError("invoice_source_import_required");
  const result =
    await sql<MercuryRecord>`SELECT id,"supplierId","purchaseInvoiceId","reviewStatus",attachments
    FROM public."mercuryTransactionImport" WHERE "companyId"=${actor.companyId} AND id=${input.mercuryImportId}
    ${lock ? sql`FOR UPDATE` : sql``}`.execute(db);
  const record = result.rows[0];
  if (!record)
    throw new InvoiceSourceError("invoice_source_import_unavailable");
  const attachment = input.storagePath
    ? parseMercuryAttachments(record.attachments).find(
        (item) =>
          item.path === input.storagePath &&
          item.source === input.kind &&
          isMercuryAttachmentPath(actor.companyId, item.path)
      )
    : undefined;
  if (input.storagePath && !attachment)
    throw new InvoiceSourceError("invoice_source_attachment_unavailable");
  return { record, attachment };
}

/** Stores evidence, then atomically registers its identity. Dispatch only after this returns. */
export async function registerInvoiceSource(
  db: InvoiceDatabase,
  storage: InvoiceStorage,
  actor: InvoiceActor,
  input: InvoiceSourceInput
): Promise<RegisteredInvoiceSource> {
  if (
    !["upload", "mercury", "gmail"].includes(input.kind) ||
    !input.sourceKey ||
    input.sourceKey.length > 2000 ||
    Array.from(input.sourceKey).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new InvoiceSourceError("invoice_source_invalid");
  if (
    input.kind === "upload"
      ? !input.bytes || !!input.storagePath || !!input.mercuryImportId
      : !!input.bytes
  ) {
    throw new InvoiceSourceError("invoice_source_invalid");
  }
  if (input.kind === "gmail" && !input.storagePath)
    throw new InvoiceSourceError("invoice_source_attachment_required");
  await assertInvoiceSourceAccess(db, actor);
  const prospectiveId = `ini_${randomUUID()}`;
  let file: SourceFile | undefined;
  let provenance: Record<string, unknown> = {};
  if (input.kind === "upload") {
    const bytes = input.bytes!;
    const verified = validateInvoiceSourceBytes(bytes);
    const storagePath = `${actor.companyId}/invoice-intake/${prospectiveId}/source/${verified.sha256}.${verified.extension}`;
    const { error } = await storage.from("private").upload(storagePath, bytes, {
      contentType: verified.mediaType,
      upsert: false
    });
    if (error) throw new InvoiceSourceError("invoice_source_upload_failed");
    file = {
      ...verified,
      storagePath,
      fileName: (input.fileName || `document.${verified.extension}`).slice(
        0,
        500
      )
    };
  } else {
    const { record, attachment } = await ownedMercury(db, actor, input);
    provenance = { mercuryImportId: record.id, ...(attachment ?? {}) };
    if (attachment) {
      const { data, error } = await storage
        .from("private")
        .download(attachment.path);
      if (error || !data)
        throw new InvoiceSourceError("invoice_source_attachment_unavailable");
      if (data.size > INVOICE_LIMITS.pdfBytes)
        throw new InvoiceSourceError("invoice_source_size_invalid");
      const verified = validateInvoiceSourceBytes(
        new Uint8Array(await data.arrayBuffer())
      );
      file = {
        ...verified,
        storagePath: attachment.path,
        fileName: attachment.fileName.slice(0, 500)
      };
    }
  }

  // Storage is immutable evidence outside this transaction. A failed registration
  // can leave an unreferenced private object; it cannot lose or replace an original.
  return db.transaction().execute(async (trx) => {
    await lockCompanyInvoiceApproval(trx, actor.companyId);
    await assertInvoiceSourceAccess(trx, actor);
    const imported =
      input.kind !== "upload"
        ? await ownedMercury(trx, actor, input, true)
        : undefined;
    const savedAttachments = parseMercuryAttachments(
      imported?.record.attachments
    );
    if (
      input.mercuryDocumentSet &&
      (JSON.stringify(savedAttachments) !==
        input.mercuryDocumentSet.attachments ||
        (file && !input.mercuryDocumentSet.sha256s.includes(file.sha256)))
    )
      throw new InvoiceSourceError("invoice_source_changed");
    const singleMercuryDocument = input.mercuryDocumentSet
      ? new Set(input.mercuryDocumentSet.sha256s).size === 1
      : savedAttachments.filter((attachment) => attachment.source === "mercury")
          .length === 1;
    const needsSourceSelection =
      !!imported &&
      !!input.mercuryDocumentSet &&
      !!file &&
      !singleMercuryDocument;
    const linkedInvoiceId =
      input.purchaseInvoiceId || imported?.record.purchaseInvoiceId || null;
    if (
      input.purchaseInvoiceId &&
      imported?.record.purchaseInvoiceId &&
      input.purchaseInvoiceId !== imported.record.purchaseInvoiceId
    ) {
      throw new InvoiceSourceError("invoice_source_invoice_conflict");
    }
    const invoice = linkedInvoiceId
      ? await trx
          .selectFrom("purchaseInvoice")
          .select(["id", "status", "supplierId"])
          .where("companyId", "=", actor.companyId)
          .where("id", "=", linkedInvoiceId)
          .executeTakeFirst()
      : undefined;
    if (linkedInvoiceId && !invoice)
      throw new InvoiceSourceError("invoice_source_invoice_unavailable");
    const sources = await trx
      .selectFrom("invoiceIntakeSource")
      .select([
        "id",
        "intakeId",
        "sha256",
        "kind",
        "sourceKey",
        "storagePath",
        "mercuryImportId"
      ])
      .where("companyId", "=", actor.companyId)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("kind", "=", input.kind),
            eb("sourceKey", "=", input.sourceKey)
          ]),
          ...(file &&
          (!imported || !input.mercuryDocumentSet || singleMercuryDocument)
            ? [
                eb.and([
                  eb("sha256", "=", file.sha256),
                  eb("kind", "!=", "gmail"),
                  ...(imported && input.mercuryDocumentSet
                    ? [
                        sql<boolean>`NOT EXISTS (
                        SELECT 1 FROM public."invoiceIntakeSource" other
                        WHERE other."companyId"=${actor.companyId}
                          AND other."intakeId"="invoiceIntakeSource"."intakeId"
                          AND other.kind<>'gmail' AND other.sha256 IS NOT NULL AND other.sha256<>${file.sha256})
                      AND NOT EXISTS (
                        SELECT 1 FROM public."invoiceIntakeSource" payment
                        JOIN public."mercuryTransactionImport" m
                          ON m."companyId"=payment."companyId" AND m.id=payment."mercuryImportId"
                        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments)='array' THEN m.attachments ELSE '[]'::jsonb END) a
                        WHERE payment."companyId"=${actor.companyId}
                          AND payment."intakeId"="invoiceIntakeSource"."intakeId"
                          AND a->>'source'='mercury'
                          AND NOT EXISTS (SELECT 1 FROM public."invoiceIntakeSource" saved
                            WHERE saved."companyId"=payment."companyId" AND saved."intakeId"=payment."intakeId"
                              AND saved."mercuryImportId"=m.id AND saved."storagePath"=a->>'path'
                              AND saved.kind=a->>'source'))`
                      ]
                    : [])
                ])
              ]
            : []),
          ...(input.mercuryImportId
            ? [eb("mercuryImportId", "=", input.mercuryImportId)]
            : []),
          ...(input.existingIntakeId
            ? [eb("intakeId", "=", input.existingIntakeId)]
            : [])
        ])
      )
      .execute();
    const same =
      sources.find(
        (source) =>
          source.kind === input.kind && source.sourceKey === input.sourceKey
      ) ??
      // Foreign-company restore remaps canonical import/path references while
      // preserving opaque historical source keys. Canonical identity still wins.
      (input.mercuryImportId
        ? sources.find(
            (source) =>
              source.kind === input.kind &&
              source.mercuryImportId === input.mercuryImportId &&
              source.storagePath === (input.storagePath || null)
          )
        : undefined);
    if (same?.sha256 && file && same.sha256 !== file.sha256)
      throw new InvoiceSourceError("invoice_source_identity_conflict");
    const intakeIds = new Set(sources.map((source) => source.intakeId));
    if (linkedInvoiceId) {
      const paymentOwners = new Set(
        sources
          .filter(
            (source) =>
              input.mercuryImportId &&
              source.mercuryImportId === input.mercuryImportId
          )
          .map((source) => source.intakeId)
      );
      const confirmedOwner =
        paymentOwners.size === 1
          ? await trx
              .selectFrom("invoiceIntake")
              .select("id")
              .where("companyId", "=", actor.companyId)
              .where("id", "=", [...paymentOwners][0]!)
              .where("purchaseInvoiceId", "=", linkedInvoiceId)
              .executeTakeFirst()
          : undefined;
      const linkedQuery = trx
        .selectFrom("invoiceIntake")
        .select("id")
        .where("companyId", "=", actor.companyId)
        .where("purchaseInvoiceId", "=", linkedInvoiceId);
      const linkedIntakes = await (confirmedOwner
        ? linkedQuery.where("id", "in", [...intakeIds])
        : linkedQuery.limit(2)
      ).execute();
      // Several separately reviewed intakes may already document this explicit
      // native invoice link. A new payment gets its own provenance container.
      const separatePayment =
        input.kind === "mercury" &&
        imported?.record.purchaseInvoiceId === linkedInvoiceId &&
        !file &&
        !input.existingIntakeId &&
        sources.length === 0 &&
        linkedIntakes.length > 1;
      for (const linked of linkedIntakes) {
        if (separatePayment) continue;
        // Explicitly linking separately reviewed evidence to the same native
        // invoice confirms its ownership without merging either review.
        if (
          confirmedOwner &&
          linked.id !== confirmedOwner.id &&
          same?.intakeId !== linked.id
        )
          intakeIds.delete(linked.id);
        else intakeIds.add(linked.id);
      }
    }
    if (input.existingIntakeId) intakeIds.add(input.existingIntakeId);
    let recoveredHistorical: boolean | undefined;
    if (intakeIds.size > 1) {
      const hashOwners = new Set(
        sources
          .filter((source) => file && source.sha256 === file.sha256)
          .map((source) => source.intakeId)
      );
      if (
        !input.mercuryImportId ||
        input.existingIntakeId ||
        !singleMercuryDocument ||
        intakeIds.size !== 2 ||
        hashOwners.size !== 1
      )
        throw new InvoiceSourceError("invoice_source_intake_conflict");
      const canonicalId = [...hashOwners][0]!;
      const placeholderId = [...intakeIds].find((id) => id !== canonicalId)!;
      const canonical = await trx
        .selectFrom("invoiceIntake")
        .select(["status", "supplierId", "newSupplier"])
        .where("companyId", "=", actor.companyId)
        .where("id", "=", canonicalId)
        .where(sql<boolean>`NOT EXISTS (
          SELECT 1 FROM public."invoiceIntakeSource" s
          WHERE s."companyId"=${actor.companyId} AND s."intakeId"=${canonicalId}
            AND s.sha256 IS NOT NULL AND s.sha256<>${file!.sha256})`)
        .forUpdate()
        .executeTakeFirst();
      if (!canonical)
        throw new InvoiceSourceError("invoice_source_intake_conflict");
      // A previous payment-first registration may have committed only its empty
      // placeholder before encountering an already-known attachment. Move that
      // provenance, never reviewed facts or another document, to the hash owner.
      const placeholder = await trx
        .selectFrom("invoiceIntake as i")
        .select(["i.id", "i.supplierId", "i.historical"])
        .where("i.companyId", "=", actor.companyId)
        .where("i.id", "=", placeholderId)
        .where("i.status", "=", "NeedsDocument")
        .where("i.revision", "=", 0)
        .where("i.generation", "=", 0)
        .where("i.documentKind", "=", "unknown")
        .where("i.attachmentStatus", "=", "None")
        .where(sql<boolean>`i.header='{}'::jsonb
          AND i."newSupplier" IS NULL AND i."purchaseInvoiceId" IS NULL
          AND i."activeExtractionId" IS NULL AND i."locationId" IS NULL
          AND i."paymentTermId" IS NULL AND i."invoiceSupplierId" IS NULL
          AND i."invoiceSupplierContactId" IS NULL AND i."invoiceSupplierLocationId" IS NULL
          AND i."approvalKey" IS NULL AND i."approvalSnapshot" IS NULL
          AND i."approvedBy" IS NULL AND i."approvedAt" IS NULL
          AND i."lastErrorCode" IS NULL AND i."updatedBy" IS NULL AND i."updatedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM public."invoiceIntakeLine" l
            WHERE l."companyId"=i."companyId" AND l."intakeId"=i.id)
          AND NOT EXISTS (SELECT 1 FROM public."documentExtraction" e
            WHERE e."companyId"=i."companyId" AND e."intakeId"=i.id)
          AND NOT EXISTS (SELECT 1 FROM public."invoiceRecognitionRule" r
            WHERE r."companyId"=i."companyId" AND r."intakeId"=i.id)
          AND NOT EXISTS (SELECT 1 FROM public."invoiceIntakeSource" s
            WHERE s."companyId"=i."companyId" AND s."intakeId"=i.id
              AND (s.kind<>'mercury' OR s."mercuryImportId" IS DISTINCT FROM ${input.mercuryImportId}
                OR s."storagePath" IS NOT NULL OR s.sha256 IS NOT NULL))`)
        .forUpdate()
        .executeTakeFirst();
      if (
        !placeholder ||
        canonical.status === "Ignored" ||
        (placeholder.supplierId &&
          (placeholder.supplierId !== imported?.record.supplierId ||
            canonical.newSupplier ||
            (canonical.supplierId &&
              canonical.supplierId !== placeholder.supplierId)))
      )
        throw new InvoiceSourceError("invoice_source_intake_conflict");
      await trx
        .updateTable("invoiceIntakeSource")
        .set({ intakeId: canonicalId })
        .where("companyId", "=", actor.companyId)
        .where("intakeId", "=", placeholderId)
        .execute();
      await trx
        .deleteFrom("invoiceIntake")
        .where("companyId", "=", actor.companyId)
        .where("id", "=", placeholderId)
        .execute();
      recoveredHistorical = placeholder.historical;
      intakeIds.delete(placeholderId);
      for (const source of sources)
        if (source.intakeId === placeholderId) source.intakeId = canonicalId;
    }
    const existingId = [...intakeIds][0];
    let intake = existingId
      ? await trx
          .selectFrom("invoiceIntake")
          .selectAll()
          .where("companyId", "=", actor.companyId)
          .where("id", "=", existingId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (existingId && !intake)
      throw new InvoiceSourceError("invoice_source_intake_unavailable");
    if (
      intake?.purchaseInvoiceId &&
      linkedInvoiceId &&
      intake.purchaseInvoiceId !== linkedInvoiceId
    ) {
      throw new InvoiceSourceError("invoice_source_invoice_conflict");
    }
    if (
      intake &&
      linkedInvoiceId &&
      !intake.purchaseInvoiceId &&
      ["Approved", "Linked"].includes(intake.status)
    ) {
      throw new InvoiceSourceError("invoice_source_invoice_conflict");
    }
    const sourceReview = invoiceSourceReviewSchema.safeParse(intake?.header);
    const selectedPrimary = sourceReview.success
      ? sourceReview.data.primarySourceSha256
      : null;
    const requiresSourceSelection =
      needsSourceSelection &&
      (!selectedPrimary ||
        !input.mercuryDocumentSet?.sha256s.includes(selectedPrimary));
    const ignored = imported?.record.reviewStatus === "Ignored";
    const evidenceOnly = invoice && invoice.status !== "Draft";
    const recordedSupplierId =
      imported?.record.supplierId || invoice?.supplierId || null;
    const metadataChanged =
      intake &&
      !["Approved", "Linked", "Ignored"].includes(intake.status) &&
      (ignored ||
        evidenceOnly ||
        (linkedInvoiceId && !intake.purchaseInvoiceId) ||
        (recordedSupplierId && !intake.supplierId && !intake.newSupplier));
    if (!intake) {
      intake = await trx
        .insertInto("invoiceIntake")
        .values({
          id: prospectiveId,
          companyId: actor.companyId,
          createdBy: actor.userId,
          historical: input.historical ?? false,
          status: ignored
            ? "Ignored"
            : evidenceOnly
              ? "Linked"
              : requiresSourceSelection
                ? "NeedsReview"
                : file
                  ? "Queued"
                  : "NeedsDocument",
          attachmentStatus:
            evidenceOnly && !ignored && file ? "Pending" : "None",
          supplierId:
            imported?.record.supplierId || invoice?.supplierId || null,
          purchaseInvoiceId: linkedInvoiceId,
          lastErrorCode: requiresSourceSelection
            ? "invoice_source_selection_required"
            : null,
          ...(evidenceOnly && !ignored
            ? { approvedBy: actor.userId, approvedAt: sql<string>`now()` }
            : {})
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } else if (
      !same ||
      (!same.sha256 && file) ||
      metadataChanged ||
      recoveredHistorical !== undefined ||
      (requiresSourceSelection && intake.status === "Queued")
    ) {
      const terminal = ["Approved", "Linked", "Ignored"].includes(
        intake.status
      );
      intake = await trx
        .updateTable("invoiceIntake")
        .set({
          updatedBy: actor.userId,
          updatedAt: sql<string>`now()`,
          historical: intake.historical || !!recoveredHistorical,
          revision: sql<number>`revision+1`,
          ...((file || sources.some((source) => source.storagePath)) &&
          ((file && ["Approved", "Linked"].includes(intake.status)) ||
            (!terminal && !ignored && evidenceOnly))
            ? { attachmentStatus: "Pending" }
            : {}),
          ...(!terminal && !intake.purchaseInvoiceId && linkedInvoiceId
            ? { purchaseInvoiceId: linkedInvoiceId }
            : {}),
          ...(!terminal &&
          !intake.supplierId &&
          !intake.newSupplier &&
          recordedSupplierId
            ? { supplierId: recordedSupplierId }
            : {}),
          ...(!terminal && ignored
            ? { status: "Ignored" }
            : !terminal && evidenceOnly
              ? {
                  status: "Linked",
                  approvedBy: actor.userId,
                  approvedAt: sql<string>`now()`
                }
              : intake.status === "Processing"
                ? {
                    // This revision no longer belongs to the active attempt.
                    // Keep its eventual evidence/billing, but exclude it from
                    // hydration and readiness recovery for the current review.
                    status: "NeedsReview",
                    activeExtractionId: null,
                    lastErrorCode: "invoice_source_changed"
                  }
                : intake.status === "Ready" &&
                    file &&
                    !sources.some((source) => source.sha256 === file.sha256)
                  ? {
                      status: "NeedsReview",
                      lastErrorCode: "invoice_source_changed"
                    }
                  : file &&
                      (intake.status === "NeedsDocument" ||
                        (intake.status === "NeedsReview" &&
                          !intake.activeExtractionId &&
                          !sources.some(
                            (source) =>
                              source.kind !== "gmail" && source.storagePath
                          )))
                    ? {
                        status: requiresSourceSelection
                          ? "NeedsReview"
                          : "Queued",
                        lastErrorCode: requiresSourceSelection
                          ? "invoice_source_selection_required"
                          : null
                      }
                    : requiresSourceSelection && intake.status === "Queued"
                      ? {
                          status: "NeedsReview",
                          lastErrorCode: "invoice_source_selection_required"
                        }
                      : {})
        })
        .where("companyId", "=", actor.companyId)
        .where("id", "=", intake.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    const fileValues = file
      ? {
          storageBucket: "private",
          storagePath: file.storagePath,
          sha256: file.sha256,
          mediaType: file.mediaType,
          byteSize: file.byteSize,
          fileName: file.fileName
        }
      : {};
    let sourceId = same?.id;
    if (same && !same.sha256 && file) {
      await trx
        .updateTable("invoiceIntakeSource")
        .set({
          ...fileValues,
          provenance: sql`${JSON.stringify(provenance)}::jsonb`,
          updatedBy: actor.userId,
          updatedAt: sql<string>`now()`
        })
        .where("companyId", "=", actor.companyId)
        .where("id", "=", same.id)
        .execute();
    } else if (!same) {
      const source = await trx
        .insertInto("invoiceIntakeSource")
        .values({
          companyId: actor.companyId,
          intakeId: intake.id,
          kind: input.kind,
          sourceKey: input.sourceKey,
          mercuryImportId: input.mercuryImportId || null,
          createdBy: actor.userId,
          provenance: sql`${JSON.stringify(provenance)}::jsonb`,
          ...fileValues
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      sourceId = source.id;
    }
    return {
      intakeId: intake.id,
      sourceId: sourceId!,
      existing: !!existingId,
      generation: intake.generation,
      status: intake.status,
      needsDispatch: intake.status === "Queued"
    };
  });
}
