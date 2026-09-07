import { createHash } from "node:crypto";
import { isMercuryAttachmentPath } from "@carbon/database/mercury";
import { round } from "@carbon/utils";
import { sql } from "kysely";
import { getInvoiceApprovedSourceHashes, INVOICE_LIMITS } from "./contracts";
import { isInvoiceSourcePath } from "./ingestion";
import type { InvoiceWorkerContext } from "./worker";

type Context = Pick<
  InvoiceWorkerContext,
  "db" | "storage" | "companyId" | "intakeId"
>;
type Source = {
  id: string;
  storageBucket: string | null;
  storagePath: string | null;
  sha256: string | null;
  byteSize: number | null;
  mediaType: string | null;
  fileName: string | null;
};

export async function pendingInvoiceAttachments(db: Context["db"]) {
  return db
    .selectFrom("invoiceIntake")
    .select(["companyId", "id as intakeId"])
    .where("status", "in", ["Approved", "Linked"])
    .where("attachmentStatus", "in", ["Pending", "Failed"])
    .where("purchaseInvoiceId", "is not", null)
    .orderBy("updatedAt")
    .limit(25)
    .execute();
}

/** Idempotent, post-approval file work. Original sources remain authoritative. */
export async function copyInvoiceAttachments(context: Context) {
  return context.db.connection().execute(async (db) => {
    const key = `invoice-attachments:${context.companyId}:${context.intakeId}`;
    const lock = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_lock(hashtext(${key})) AS locked`.execute(db);
    if (!lock.rows[0]?.locked) return { state: "busy", copied: 0 };
    let copied = 0;
    try {
      const intake = await db
        .selectFrom("invoiceIntake")
        .select([
          "status",
          "purchaseInvoiceId",
          "approvedBy",
          "updatedBy",
          "createdBy",
          "approvalSnapshot"
        ])
        .where("companyId", "=", context.companyId)
        .where("id", "=", context.intakeId)
        .executeTakeFirst();
      if (
        !intake ||
        !["Approved", "Linked"].includes(intake.status) ||
        !intake.purchaseInvoiceId
      )
        return { state: "stale", copied };
      const userId = intake.approvedBy || intake.updatedBy || intake.createdBy;
      const permission = await sql<{ allowed: boolean }>`SELECT EXISTS (
        SELECT 1 FROM public.employee e JOIN public."user" u ON u.id=e.id
        JOIN public."userToCompany" c ON c."userId"=e.id AND c."companyId"=e."companyId"
        JOIN public."userPermission" p ON p.id=e.id
        WHERE e."companyId"=${context.companyId} AND e.id=${userId} AND e.active AND u.active AND c.role='employee'
          AND p.permissions->'invoicing_view' @> ${JSON.stringify([context.companyId])}::jsonb
      ) AS allowed`.execute(db);
      if (!permission.rows[0]?.allowed)
        throw new Error("invoice_attachment_operator_unavailable");
      const invoice = await db
        .selectFrom("purchaseInvoice")
        .select("id")
        .where("companyId", "=", context.companyId)
        .where("id", "=", intake.purchaseInvoiceId)
        .executeTakeFirst();
      if (!invoice) throw new Error("invoice_attachment_invoice_unavailable");
      const approvedHashes = getInvoiceApprovedSourceHashes(
        intake.approvalSnapshot
      );
      const sources: Source[] = await db
        .selectFrom("invoiceIntakeSource")
        .select([
          "id",
          "storageBucket",
          "storagePath",
          "sha256",
          "byteSize",
          "mediaType",
          "fileName"
        ])
        .where("companyId", "=", context.companyId)
        .where("intakeId", "=", context.intakeId)
        .where("storagePath", "is not", null)
        .where("kind", "in", ["mercury", "upload"])
        .where(
          approvedHashes === null
            ? sql<boolean>`(kind='upload' OR coalesce(provenance->>'current','true')<>'false')`
            : sql<boolean>`sha256=ANY(${approvedHashes}::text[])`
        )
        .orderBy("createdAt")
        .orderBy("id")
        .limit(26)
        .execute();
      if (
        approvedHashes !== null &&
        (!approvedHashes.length ||
          approvedHashes.some(
            (hash) => !sources.some((source) => source.sha256 === hash)
          ))
      )
        throw new Error("invoice_attachment_approved_source_missing");
      if (sources.length > 25) throw new Error("invoice_attachment_limit");
      const documents: Array<{
        path: string;
        name: string;
        size: number;
        type: "PDF" | "Image";
      }> = [];
      for (const source of sources) {
        const extension =
          source.mediaType === "application/pdf"
            ? "pdf"
            : source.mediaType === "image/png"
              ? "png"
              : source.mediaType === "image/jpeg"
                ? "jpg"
                : source.mediaType === "image/webp"
                  ? "webp"
                  : null;
        if (
          !source.storagePath ||
          source.storageBucket !== "private" ||
          !source.sha256 ||
          !/^[0-9a-f]{64}$/.test(source.sha256) ||
          !extension ||
          !source.byteSize ||
          source.byteSize > INVOICE_LIMITS.pdfBytes ||
          !(
            isInvoiceSourcePath(context.companyId, source.storagePath) ||
            isMercuryAttachmentPath(context.companyId, source.storagePath)
          )
        )
          throw new Error("invoice_attachment_source_invalid");
        const name = `${
          (source.fileName ?? "receipt")
            .replace(/\.[^.]*$/, "")
            .replace(/[^a-zA-Z0-9_-]+/g, "_")
            .slice(0, 70) || "receipt"
        }.${extension}`;
        const destination = `${context.companyId}/invoice-intake/${context.intakeId}/invoice/${invoice.id}/${source.sha256}-${name}`;
        const bucket = context.storage.from("private");
        const existing = await bucket.download(destination);
        const file =
          existing.data ?? (await bucket.download(source.storagePath)).data;
        if (!file || file.size !== Number(source.byteSize))
          throw new Error("invoice_attachment_source_changed");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
          throw new Error("invoice_attachment_source_changed");
        if (!existing.data) {
          const upload = await bucket.upload(destination, bytes, {
            upsert: false,
            contentType: source.mediaType!
          });
          if (upload.error) throw new Error("invoice_attachment_copy_failed");
        }
        documents.push({
          path: destination,
          name,
          // Native document metadata stores rounded KiB; source byteSize and
          // hash verification above continue to use exact bytes.
          size: round(bytes.length / 1024, 0),
          type: extension === "pdf" ? "PDF" : "Image"
        });
        copied++;
      }
      await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("invoiceIntake")
          .select(["status", "purchaseInvoiceId"])
          .where("companyId", "=", context.companyId)
          .where("id", "=", context.intakeId)
          .forUpdate()
          .executeTakeFirst();
        if (
          !current ||
          current.purchaseInvoiceId !== invoice.id ||
          !["Approved", "Linked"].includes(current.status)
        )
          return;
        const existing = documents.length
          ? await trx
              .selectFrom("document")
              .select("path")
              .where("companyId", "=", context.companyId)
              .where(
                "path",
                "in",
                documents.map((document) => document.path)
              )
              .execute()
          : [];
        const paths = new Set(existing.map((document) => document.path));
        const missing = [
          ...new Map(
            documents
              .filter((document) => !paths.has(document.path))
              .map((document) => [document.path, document])
          ).values()
        ];
        if (missing.length)
          await trx
            .insertInto("document")
            .values(
              missing.map((document) => ({
                ...document,
                companyId: context.companyId,
                createdBy: userId,
                sourceDocument: "Purchase Invoice" as const,
                sourceDocumentId: invoice.id,
                readGroups: [],
                writeGroups: []
              }))
            )
            .execute();
        const currentSources = await trx
          .selectFrom("invoiceIntakeSource")
          .select("id")
          .where("companyId", "=", context.companyId)
          .where("intakeId", "=", context.intakeId)
          .where("storagePath", "is not", null)
          .where("kind", "in", ["mercury", "upload"])
          .where(
            approvedHashes === null
              ? sql<boolean>`(kind='upload' OR coalesce(provenance->>'current','true')<>'false')`
              : sql<boolean>`sha256=ANY(${approvedHashes}::text[])`
          )
          .execute();
        const ids = new Set(sources.map((source) => source.id));
        const complete = currentSources.every((source) => ids.has(source.id));
        await trx
          .updateTable("invoiceIntake")
          .set({
            attachmentStatus: complete
              ? documents.length
                ? "Complete"
                : "None"
              : "Pending",
            lastErrorCode: null,
            updatedAt: sql`now()`
          })
          .where("companyId", "=", context.companyId)
          .where("id", "=", context.intakeId)
          .execute();
      });
      return { state: "complete", copied };
    } catch (error) {
      const code =
        error instanceof Error &&
        /^invoice_attachment_[a-z_]+$/.test(error.message)
          ? error.message
          : "invoice_attachment_copy_failed";
      await db
        .updateTable("invoiceIntake")
        .set({
          attachmentStatus: "Failed",
          lastErrorCode: code,
          updatedAt: sql`now()`
        })
        .where("companyId", "=", context.companyId)
        .where("id", "=", context.intakeId)
        .where("status", "in", ["Approved", "Linked"])
        .execute();
      return { state: "failed", copied };
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext(${key}))`.execute(db);
    }
  });
}
