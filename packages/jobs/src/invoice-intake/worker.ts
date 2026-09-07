import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@carbon/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import type { JobDatabase } from "../db";
import {
  hasInvoiceReviewFacts,
  INVOICE_LIMITS,
  INVOICE_PROMPT_VERSION,
  INVOICE_SCHEMA_VERSION,
  type InvoiceExtractionEnvelope,
  type InvoiceMatchSuggestions,
  invoiceExtractionEnvelopeSchema,
  invoiceMatchSuggestionsSchema,
  invoiceSourceReviewSchema
} from "./contracts";
import { validateInvoiceImage } from "./image";
import {
  type GoogleInvoiceProvider,
  type InvoiceDocumentInput,
  type InvoiceMatchInput,
  InvoiceProviderError,
  type InvoiceProviderResult,
  invoiceUsageCost,
  type PreparedInvoiceRequest
} from "./provider";
import { resolveInvoiceCandidates } from "./recognition";
import { validateInvoiceIntake } from "./validation";

export type InvoiceWorkerContext = {
  db: JobDatabase;
  storage: SupabaseClient<Database>["storage"];
  companyId: string;
  intakeId: string;
  generation: number;
  revision?: number;
  provider: GoogleInvoiceProvider;
};
type WorkState =
  | "disabled"
  | "missing"
  | "busy"
  | "budget"
  | "attempt_limit"
  | "complete"
  | "stale"
  | "retry"
  | "review";
export type InvoiceWorkResult = { state: WorkState; attemptId?: string };
type Intake = {
  id: string;
  companyId: string;
  generation: number;
  revision: number;
  status: string;
  createdBy: string;
  updatedBy: string | null;
  activeExtractionId: string | null;
  supplierId: string | null;
  header: unknown;
};
type Source = {
  storageBucket: string;
  storagePath: string;
  sha256: string;
  mediaType: string;
  byteSize: string | number;
};

export async function invoiceOperatorAllowed(
  db: JobDatabase,
  companyId: string,
  userId: string
): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`SELECT EXISTS (
    SELECT 1 FROM public.employee e
    JOIN public."user" u ON u.id = e.id
    JOIN public."userToCompany" c ON c."userId" = e.id AND c."companyId" = e."companyId"
    JOIN public."userPermission" p ON p.id = e.id
    WHERE e."companyId" = ${companyId} AND e.id = ${userId}
      AND e.active AND u.active AND c.role = 'employee'
      AND (p.permissions->'invoicing_view' @> ${JSON.stringify([companyId])}::jsonb)
      AND (p.permissions->'invoicing_update' @> ${JSON.stringify([companyId])}::jsonb
        OR p.permissions->'invoicing_create' @> ${JSON.stringify([companyId])}::jsonb)
  ) AS allowed`.execute(db);
  return result.rows[0]?.allowed === true;
}

async function getIntake(context: InvoiceWorkerContext) {
  const result =
    await sql<Intake>`SELECT id,"companyId",generation,revision,status,"createdBy","updatedBy","activeExtractionId","supplierId",header
    FROM public."invoiceIntake" WHERE "companyId"=${context.companyId} AND id=${context.intakeId}`.execute(
      context.db
    );
  return result.rows[0];
}

async function enabled(context: InvoiceWorkerContext, intake: Intake) {
  const result = await sql<{
    enabled: boolean;
  }>`SELECT enabled FROM public."invoiceIntakeSettings" WHERE "companyId"=${context.companyId}`.execute(
    context.db
  );
  return (
    context.provider.config.enabled &&
    result.rows[0]?.enabled === true &&
    (await invoiceOperatorAllowed(
      context.db,
      context.companyId,
      intake.updatedBy || intake.createdBy
    ))
  );
}

async function loadDocument(
  context: InvoiceWorkerContext,
  intake: Intake
): Promise<{ source: Source; input: InvoiceDocumentInput }> {
  const sources =
    await sql<Source>`SELECT "storageBucket","storagePath",sha256,"mediaType","byteSize"
    FROM public."invoiceIntakeSource" WHERE "companyId"=${context.companyId} AND "intakeId"=${context.intakeId}
      AND "storagePath" IS NOT NULL AND kind IN ('mercury','upload') AND (kind='upload' OR coalesce(provenance->>'current','true')<>'false') ORDER BY "createdAt",id`.execute(
      context.db
    );
  const selection = invoiceSourceReviewSchema.safeParse(intake.header);
  if (!selection.success)
    throw new InvoiceProviderError("invoice_source_selection_invalid");
  if (!sources.rows.length)
    throw new InvoiceProviderError("invoice_document_missing");
  const hashes = new Set(sources.rows.map((source) => source.sha256));
  const primary =
    selection.data.primarySourceSha256 ??
    (hashes.size === 1 ? sources.rows[0]?.sha256 : null);
  if (!primary && hashes.size > 1)
    throw new InvoiceProviderError("invoice_source_selection_required");
  const source = sources.rows.find((source) => source.sha256 === primary);
  if (
    !source ||
    source.storageBucket !== "private" ||
    !source.storagePath.startsWith(`${context.companyId}/`) ||
    source.storagePath
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    !/^[0-9a-f]{64}$/.test(source.sha256)
  )
    throw new InvoiceProviderError("invoice_source_unavailable");
  const size = Number(source.byteSize);
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > INVOICE_LIMITS.pdfBytes
  )
    throw new InvoiceProviderError("invoice_source_size_invalid");
  const { data, error } = await context.storage
    .from(source.storageBucket)
    .download(source.storagePath);
  if (error || !data || data.size !== size)
    throw new InvoiceProviderError("invoice_source_unavailable");
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
    throw new InvoiceProviderError("invoice_source_changed");
  let mimeType: InvoiceDocumentInput["mimeType"];
  if (Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-") {
    mimeType = "application/pdf";
    await import("@carbon/lib/shims");
    // @ts-ignore pdfjs legacy bundle intentionally has no declarations.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // @ts-ignore pdfjs worker bundle intentionally has no declarations.
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    let pdf:
      | Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>
      | undefined;
    try {
      pdf = await pdfjs.getDocument({
        data: bytes.slice(),
        isEvalSupported: false
      }).promise;
      if (pdf.numPages < 1 || pdf.numPages > INVOICE_LIMITS.pages)
        throw new InvoiceProviderError("invoice_page_limit");
    } catch (failure) {
      if (failure instanceof InvoiceProviderError) throw failure;
      throw new InvoiceProviderError("invoice_pdf_invalid");
    } finally {
      await pdf?.destroy();
    }
  } else if (
    bytes[0] === 0x89 &&
    Buffer.from(bytes.subarray(1, 4)).toString() === "PNG"
  )
    mimeType = "image/png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    mimeType = "image/jpeg";
  else if (
    Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP"
  )
    mimeType = "image/webp";
  else throw new InvoiceProviderError("invoice_media_unsupported");
  if (mimeType !== source.mediaType)
    throw new InvoiceProviderError("invoice_media_mismatch");
  if (
    mimeType !== "application/pdf" &&
    bytes.length > INVOICE_LIMITS.imageBytes
  )
    throw new InvoiceProviderError("invoice_source_size_invalid");
  if (mimeType !== "application/pdf") {
    try {
      await validateInvoiceImage(bytes, mimeType);
    } catch (error) {
      throw new InvoiceProviderError(
        error instanceof Error && error.message.startsWith("invoice_image_")
          ? error.message
          : "invoice_image_invalid"
      );
    }
  }
  return { source, input: { bytes, mimeType } };
}

type Operation = "extract" | "match";
type MatchScope = {
  itemIds: string[];
  supplierIds: string[];
  lineKeys: string[];
};
type Claim = {
  state: "claimed";
  id: string;
  claimToken: string;
  revision: number;
  operator: string;
  operation: Operation;
  matchScope?: MatchScope;
};
async function admit(
  context: InvoiceWorkerContext,
  original: Intake,
  storagePath: string,
  reservedCostUsd: number,
  operation: Operation,
  matchScope?: MatchScope
): Promise<Claim | InvoiceWorkResult> {
  return context.db.transaction().execute(async (db) => {
    // Cross-process admission: different companies and duplicate dispatches share
    // two slots, while settings row locks serialize the per-company budget.
    await sql`SELECT pg_advisory_xact_lock(hashtext('invoice-inference-admission'))`.execute(
      db
    );
    const settings = await sql<{
      enabled: boolean;
      dailyBudgetUsd: string;
      monthlyBudgetUsd: string;
    }>`SELECT enabled,"dailyBudgetUsd","monthlyBudgetUsd"
      FROM public."invoiceIntakeSettings" WHERE "companyId"=${context.companyId} FOR UPDATE`.execute(
      db
    );
    const current = (
      await sql<Intake>`SELECT id,"companyId",generation,revision,status,"createdBy","updatedBy","activeExtractionId","supplierId",header
      FROM public."invoiceIntake" WHERE "companyId"=${context.companyId} AND id=${context.intakeId} FOR UPDATE`.execute(
        db
      )
    ).rows[0];
    if (
      !current ||
      current.generation !== context.generation ||
      current.revision !== original.revision ||
      !(
        operation === "match"
          ? ["NeedsReview", "Ready", "Processing"]
          : ["Queued", "Processing"]
      ).includes(current.status)
    )
      return { state: "stale" };
    const operator = current.updatedBy || current.createdBy;
    if (
      !settings.rows[0]?.enabled ||
      !(await invoiceOperatorAllowed(db, context.companyId, operator))
    )
      return { state: "disabled" };
    const active = await sql<{
      count: string;
      same: boolean;
    }>`SELECT count(*)::text AS count,
      coalesce(bool_or("companyId"=${context.companyId} AND "intakeId"=${context.intakeId}),false) AS same
      FROM public."documentExtraction" WHERE "intakeId" IS NOT NULL AND status='processing' AND "leaseUntil">now()`.execute(
      db
    );
    if (
      active.rows[0]?.same ||
      Number(active.rows[0]?.count) >= INVOICE_LIMITS.concurrency
    )
      return { state: "busy" };
    const count = await sql<{
      count: string;
    }>`SELECT coalesce(max("attemptNumber"),0)::text AS count FROM public."documentExtraction"
      WHERE "companyId"=${context.companyId} AND "intakeId"=${context.intakeId} AND generation=${context.generation}`.execute(
      db
    );
    const attemptNumber = Number(count.rows[0]?.count ?? 0) + 1;
    if (attemptNumber > INVOICE_LIMITS.attempts) {
      await sql`UPDATE public."invoiceIntake" SET status='NeedsReview',"lastErrorCode"='inference_attempt_limit'
        WHERE "companyId"=${context.companyId} AND id=${context.intakeId}`.execute(
        db
      );
      return { state: "attempt_limit" };
    }
    const costs = await sql<{ daily: string; monthly: string }>`SELECT
      coalesce(sum(coalesce("actualCostUsd","reservedCostUsd")) FILTER (WHERE "reservedAt">=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS daily,
      coalesce(sum(coalesce("actualCostUsd","reservedCostUsd")),0)::text AS monthly
      FROM public."documentExtraction" WHERE "companyId"=${context.companyId}
      AND "reservedAt">=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`.execute(
      db
    );
    if (
      Number(costs.rows[0]?.daily) + reservedCostUsd >
        Number(settings.rows[0].dailyBudgetUsd) ||
      Number(costs.rows[0]?.monthly) + reservedCostUsd >
        Number(settings.rows[0].monthlyBudgetUsd)
    ) {
      await sql`UPDATE public."invoiceIntake" SET "lastErrorCode"='inference_budget_exhausted',"updatedAt"=now()
        WHERE "companyId"=${context.companyId} AND id=${context.intakeId}`.execute(
        db
      );
      return { state: "budget" };
    }
    const claimToken = randomUUID();
    const config = context.provider.config;
    const priceSnapshot = JSON.stringify({
      input: config.inputPriceUsdPerMillion,
      output: config.outputPriceUsdPerMillion,
      verifiedAt: config.priceVerifiedAt
    });
    const inserted = await sql<{
      id: string;
    }>`INSERT INTO public."documentExtraction"
      ("companyId","sourceDocument","sourceDocumentId","storagePath","documentType",status,"createdBy",
       "intakeId",generation,"inputRevision","attemptNumber",operation,"schemaVersion","promptVersion","modelId",provider,"processingRegion",
       "claimToken","leaseUntil","reservedAt","reservedCostUsd","priceSnapshot","billingState","filteredData")
      VALUES (${context.companyId},'Invoice Intake',${context.intakeId},${storagePath},'purchaseInvoice','processing',${operator},
       ${context.intakeId},${context.generation},${current.revision},${attemptNumber},${operation},${INVOICE_SCHEMA_VERSION},${INVOICE_PROMPT_VERSION},${config.model},'google','us',
       ${claimToken},now()+interval '5 minutes',now(),${reservedCostUsd},${priceSnapshot}::jsonb,'Reserved',${JSON.stringify(matchScope ?? null)}::jsonb) RETURNING id`.execute(
      db
    );
    const id = inserted.rows[0]!.id;
    await sql`UPDATE public."invoiceIntake" SET status='Processing',"activeExtractionId"=${id},"lastErrorCode"=NULL
      WHERE "companyId"=${context.companyId} AND id=${context.intakeId}`.execute(
      db
    );
    return {
      state: "claimed",
      id,
      claimToken,
      revision: current.revision,
      operator,
      operation,
      matchScope
    };
  });
}

function headerFromExtraction(result: InvoiceExtractionEnvelope) {
  const isZero = (value: string | null) =>
    value !== null && /^-?0+(?:\.0+)?$/.test(value);
  // Confirm only explicit zero charges and exact decimal source arithmetic.
  // Missing charges or rounding/allocation questions require a human decision.
  const decimal = (value: string | null): [bigint, bigint] | null => {
    if (value === null) return null;
    const [whole, fraction = ""] = value.split(".");
    return [
      BigInt(`${whole}${fraction}`),
      BigInt(10) ** BigInt(fraction.length)
    ];
  };
  const same = (a: [bigint, bigint], b: [bigint, bigint]) =>
    a[0] * b[1] === b[0] * a[1];
  let sum: [bigint, bigint] = [BigInt(0), BigInt(1)];
  const zeroCharges = [
    result.header.tax,
    result.header.shipping,
    result.header.discount
  ].every((field) => isZero(field.value));
  const represented =
    result.lines.length > 0 &&
    result.lines.every((line) => {
      if (
        ![line.tax, line.shipping, line.discount].every((field) =>
          isZero(field.value)
        )
      )
        return false;
      const quantity = decimal(line.quantity.value),
        price = decimal(line.unitPrice.value),
        total = decimal(line.lineTotal.value);
      if (
        !quantity ||
        !price ||
        !total ||
        !same([quantity[0] * price[0], quantity[1] * price[1]], total)
      )
        return false;
      const scale = sum[1] > total[1] ? sum[1] : total[1];
      sum = [sum[0] * (scale / sum[1]) + total[0] * (scale / total[1]), scale];
      return true;
    });
  const subtotal = decimal(result.header.subtotal.value),
    total = decimal(result.header.total.value);
  return {
    ...Object.fromEntries(
      Object.entries(result.header).map(([key, field]) => [key, field.value])
    ),
    sourceSupplierName: result.supplier.name.value,
    sourceIssues: result.issues,
    chargesConfirmed:
      zeroCharges &&
      represented &&
      !!subtotal &&
      !!total &&
      same(sum, subtotal) &&
      same(sum, total),
    resolvedSourceIssues: result.issues.length === 0
  };
}

type Output = InvoiceProviderResult<
  InvoiceExtractionEnvelope | InvoiceMatchSuggestions
>;

async function hydrate(
  context: InvoiceWorkerContext,
  claim: Claim,
  result: InvoiceExtractionEnvelope | InvoiceMatchSuggestions
): Promise<InvoiceWorkResult> {
  const work = await context.db
    .transaction()
    .execute(async (db): Promise<InvoiceWorkResult> => {
      const intake = (
        await sql<Intake>`SELECT id,"companyId",generation,revision,status,"createdBy","updatedBy","activeExtractionId","supplierId",header
      FROM public."invoiceIntake" WHERE "companyId"=${context.companyId} AND id=${context.intakeId} FOR UPDATE`.execute(
          db
        )
      ).rows[0];
      if (
        !intake ||
        intake.generation !== context.generation ||
        intake.activeExtractionId !== claim.id ||
        intake.revision !== claim.revision ||
        intake.status !== "Processing"
      )
        return { state: "stale", attemptId: claim.id };
      if (
        !(await invoiceOperatorAllowed(db, context.companyId, claim.operator))
      ) {
        await sql`UPDATE public."invoiceIntake" SET status='NeedsReview',"lastErrorCode"='inference_operator_unavailable',"updatedAt"=now()
        WHERE "companyId"=${context.companyId} AND id=${context.intakeId}`.execute(
          db
        );
        return { state: "review", attemptId: claim.id };
      }
      if (claim.operation === "match") {
        const suggestions = invoiceMatchSuggestionsSchema.parse(result);
        const scope = claim.matchScope;
        if (
          !scope ||
          (suggestions.supplierId &&
            !scope.supplierIds.includes(suggestions.supplierId)) ||
          suggestions.lines.some(
            (line) =>
              !scope.lineKeys.includes(line.lineKey) ||
              (line.itemId && !scope.itemIds.includes(line.itemId))
          )
        )
          throw new InvoiceProviderError("inference_candidate_invalid");
        // A model cannot select records or alter money/units: these are review-only hints.
        await sql`UPDATE public."invoiceIntakeLine" l SET review=l.review || jsonb_build_object('modelSuggestion',x.suggestion),"updatedAt"=now()
        FROM jsonb_to_recordset(${JSON.stringify(suggestions.lines.map((line) => ({ lineKey: line.lineKey, suggestion: line })))}::jsonb)
          AS x("lineKey" text,suggestion jsonb)
        WHERE l."companyId"=${context.companyId} AND l."intakeId"=${context.intakeId} AND l."lineKey"=x."lineKey"`.execute(
          db
        );
        await sql`UPDATE public."invoiceIntake" SET status='NeedsReview',header=header || jsonb_build_object('modelSupplierSuggestion',${suggestions.supplierId}::text),
        revision=revision+1,"lastErrorCode"=NULL,"updatedAt"=now() WHERE "companyId"=${context.companyId} AND id=${context.intakeId}`.execute(
          db
        );
        return { state: "complete", attemptId: claim.id };
      }
      const extracted = invoiceExtractionEnvelopeSchema.parse(result);
      const existingReview = (
        await sql<{
          hasLines: boolean;
          newSupplier: boolean;
          documentKind: boolean;
          hasPreviousExtraction: boolean;
        }>`SELECT
        EXISTS(SELECT 1 FROM public."invoiceIntakeLine" l WHERE l."companyId"=i."companyId" AND l."intakeId"=i.id) AS "hasLines",
        i."newSupplier" IS NOT NULL AS "newSupplier", i."documentKind"<>'unknown' AS "documentKind",
        EXISTS(SELECT 1 FROM public."documentExtraction" e WHERE e."companyId"=i."companyId" AND e."intakeId"=i.id AND e.operation='extract' AND e.status='completed' AND e.id<>${claim.id}) AS "hasPreviousExtraction"
        FROM public."invoiceIntake" i WHERE i."companyId"=${context.companyId} AND i.id=${context.intakeId}`.execute(
          db
        )
      ).rows[0]!;
      const savedHeader =
        intake.header && typeof intake.header === "object"
          ? (intake.header as Record<string, unknown>)
          : {};
      if (
        hasInvoiceReviewFacts(savedHeader) ||
        existingReview.hasLines ||
        existingReview.newSupplier ||
        existingReview.documentKind ||
        (savedHeader._review && existingReview.hasPreviousExtraction)
      ) {
        // Keep provider output immutable and separately reviewable. A newer model
        // result is not permission to replace previously entered or accepted facts.
        await sql`UPDATE public."invoiceIntake" SET status='NeedsReview',
          header=header || jsonb_build_object('_pendingExtractionReview',${claim.id}::text),
          revision=revision+1,"lastErrorCode"='invoice_extraction_review_preserved',"updatedAt"=now()
          WHERE "companyId"=${context.companyId} AND id=${context.intakeId}`.execute(
          db
        );
        return { state: "complete", attemptId: claim.id };
      }

      const recognition = await resolveInvoiceCandidates(
        db,
        context.companyId,
        {
          supplierId: intake.supplierId,
          supplierName: extracted.supplier.name.value,
          lines: extracted.lines.map((line) => ({
            lineKey: line.lineKey,
            description: line.description.value,
            supplierSku: line.supplierSku.value,
            manufacturerPartNumber: line.manufacturerPartNumber.value,
            purchaseUnit: line.purchaseUnit.value,
            packText: line.packText.value
          }))
        }
      );
      const recognized = new Map(
        recognition.lines.map((line) => [line.lineKey, line])
      );
      await sql`DELETE FROM public."invoiceIntakeLine" WHERE "companyId"=${context.companyId} AND "intakeId"=${context.intakeId}`.execute(
        db
      );
      if (extracted.lines.length) {
        const rows = extracted.lines.map((line, index) => {
          const identity = recognized.get(line.lineKey);
          const confirmed =
            identity?.status === "matched" &&
            !recognition.supplierConflict &&
            !recognition.truncated;
          return {
            companyId: context.companyId,
            intakeId: context.intakeId,
            lineKey: line.lineKey,
            sortOrder: index,
            raw: line,
            description: line.description.value,
            supplierSku: line.supplierSku.value,
            manufacturerPartNumber: line.manufacturerPartNumber.value,
            quantity: line.quantity.value,
            supplierUnitPrice: line.unitPrice.value,
            discountAmount: line.discount.value,
            supplierTaxAmount: line.tax.value,
            taxPercent: line.taxPercent.value,
            supplierShippingCost: line.shipping.value,
            documentLineTotal: line.lineTotal.value,
            purchaseUnit: confirmed
              ? identity.purchaseUnit
              : line.purchaseUnit.value,
            lineType: confirmed ? identity.itemType : line.suggestedType.value,
            itemId: confirmed ? identity.itemId : null,
            stockUnit: confirmed ? identity.stockUnit : null,
            conversionFactor: confirmed ? identity.conversionFactor : null,
            review: {
              origin: confirmed ? "savedMatch" : "document",
              matchReason: identity?.reason,
              recognition: identity ?? null
            },
            createdBy: claim.operator
          };
        });
        await sql`INSERT INTO public."invoiceIntakeLine" ("companyId","intakeId","lineKey","sortOrder",raw,description,"supplierSku","manufacturerPartNumber",quantity,"supplierUnitPrice","discountAmount","supplierTaxAmount","taxPercent","supplierShippingCost","documentLineTotal","purchaseUnit","lineType","itemId","stockUnit","conversionFactor",review,"createdBy")
        SELECT x."companyId",x."intakeId",x."lineKey",x."sortOrder",x.raw,x.description,x."supplierSku",x."manufacturerPartNumber",x.quantity,x."supplierUnitPrice",x."discountAmount",x."supplierTaxAmount",x."taxPercent",x."supplierShippingCost",x."documentLineTotal",x."purchaseUnit",x."lineType",x."itemId",x."stockUnit",x."conversionFactor",x.review,x."createdBy"
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x("companyId" text,"intakeId" text,"lineKey" text,"sortOrder" int,raw jsonb,description text,"supplierSku" text,"manufacturerPartNumber" text,quantity numeric,"supplierUnitPrice" numeric,"discountAmount" numeric,"supplierTaxAmount" numeric,"taxPercent" numeric,"supplierShippingCost" numeric,"documentLineTotal" numeric,"purchaseUnit" text,"lineType" text,"itemId" text,"stockUnit" text,"conversionFactor" numeric,review jsonb,"createdBy" text)`.execute(
          db
        );
      }
      const header = {
        ...(savedHeader._review ? { _review: savedHeader._review } : {}),
        ...(savedHeader._defaults ? { _defaults: savedHeader._defaults } : {}),
        ...headerFromExtraction(extracted),
        ...invoiceSourceReviewSchema.parse(intake.header),
        supplierRecognition: {
          conflict: recognition.supplierConflict,
          candidates: recognition.supplierCandidates,
          truncated: recognition.truncated
        }
      };
      await sql`UPDATE public."invoiceIntake" SET status='NeedsReview',header=${JSON.stringify(header)}::jsonb,
      "supplierId"=${intake.supplierId ?? (recognition.supplierConflict ? null : recognition.supplierId)},"documentKind"=${extracted.documentKind},revision=revision+1,"lastErrorCode"=NULL,"updatedAt"=now()
      WHERE "companyId"=${context.companyId} AND id=${context.intakeId}`.execute(
        db
      );
      return { state: "complete", attemptId: claim.id };
    });
  if (work.state === "complete")
    await validateInvoiceIntake({
      db: context.db,
      companyId: context.companyId,
      intakeId: context.intakeId,
      userId: claim.operator,
      generation: context.generation,
      expectedRevision: claim.revision + 1,
      attemptId: claim.id
    });
  return work;
}

async function complete(
  context: InvoiceWorkerContext,
  claim: Claim,
  output?: Output,
  failure?: InvoiceProviderError
): Promise<InvoiceWorkResult> {
  const usage = output?.usage ?? failure?.usage;
  const actualCost = usage
    ? invoiceUsageCost(context.provider.config, usage)
    : null;
  // Commit immutable provider evidence and billing before any review hydration.
  // A crash or invalid catalog reference can then replay hydration without paying again.
  await sql`UPDATE public."documentExtraction" SET status=${output ? "completed" : "failed"}::public."documentExtractionStatus",
    "extractedData"=${output ? JSON.stringify(output.result) : null}::jsonb,
    usage=${usage ? JSON.stringify({ ...usage, modelVersion: output?.modelVersion ?? null }) : null}::jsonb,"actualCostUsd"=${actualCost},
    "billingState"=${usage ? "Reconciled" : "Unknown"},error=${failure?.code ?? null},"leaseUntil"=NULL,"updatedAt"=now()
    WHERE "companyId"=${context.companyId} AND id=${claim.id} AND "claimToken"=${claim.claimToken} AND status='processing'`.execute(
    context.db
  );
  if (output) {
    try {
      return await hydrate(context, claim, output.result);
    } catch (error) {
      if (!(error instanceof InvoiceProviderError)) throw error;
      const intake = await getIntake(context);
      if (
        !intake ||
        intake.activeExtractionId !== claim.id ||
        intake.revision !== claim.revision
      )
        return { state: "stale", attemptId: claim.id };
      return failPreflight(context, intake, error);
    }
  }
  const retry = failure?.retryable && claim.operation === "extract";
  const updated =
    await sql`UPDATE public."invoiceIntake" SET status=${retry ? "Queued" : "NeedsReview"},"lastErrorCode"=${failure?.code ?? "inference_failed"},"updatedAt"=now()
    WHERE "companyId"=${context.companyId} AND id=${context.intakeId} AND generation=${context.generation}
      AND revision=${claim.revision} AND "activeExtractionId"=${claim.id} AND status='Processing'`.execute(
      context.db
    );
  return {
    state:
      updated.numAffectedRows === BigInt(0)
        ? "stale"
        : retry
          ? "retry"
          : "review",
    attemptId: claim.id
  };
}

async function recover(
  context: InvoiceWorkerContext,
  intake: Intake
): Promise<InvoiceWorkResult | undefined> {
  if (intake.status !== "Processing" || !intake.activeExtractionId) return;
  const attempt = (
    await sql<{
      id: string;
      claimToken: string;
      inputRevision: number;
      createdBy: string;
      operation: Operation;
      status: string;
      extractedData: unknown;
      filteredData: MatchScope | null;
      active: boolean;
    }>`SELECT id,"claimToken","inputRevision","createdBy",operation,status,"extractedData","filteredData",("leaseUntil">now()) AS active
      FROM public."documentExtraction" WHERE "companyId"=${context.companyId} AND "intakeId"=${context.intakeId}
      AND generation=${context.generation} AND id=${intake.activeExtractionId}`.execute(
      context.db
    )
  ).rows[0];
  if (!attempt) return;
  if (attempt.active) return { state: "busy" };
  const claim: Claim = {
    state: "claimed",
    id: attempt.id,
    claimToken: attempt.claimToken,
    revision: attempt.inputRevision,
    operator: attempt.createdBy,
    operation: attempt.operation,
    matchScope: attempt.filteredData ?? undefined
  };
  if (attempt.status === "completed") {
    const schema =
      attempt.operation === "extract"
        ? invoiceExtractionEnvelopeSchema
        : invoiceMatchSuggestionsSchema;
    const parsed = schema.safeParse(attempt.extractedData);
    if (parsed.success) return hydrate(context, claim, parsed.data);
  }
  // Unknown billing remains reserved after a lease expires. A matching failure
  // returns to its existing review; it must never trigger a fresh extraction.
  if (attempt.operation === "match")
    return complete(
      context,
      claim,
      undefined,
      new InvoiceProviderError("inference_match_interrupted")
    );
}

async function failPreflight(
  context: InvoiceWorkerContext,
  intake: Intake,
  failure: InvoiceProviderError
) {
  await sql`UPDATE public."invoiceIntake" SET "lastErrorCode"=${failure.code},status=${failure.code === "invoice_document_missing" ? "NeedsDocument" : failure.retryable && intake.status === "Queued" ? "Queued" : "NeedsReview"},"updatedAt"=now()
    WHERE "companyId"=${context.companyId} AND id=${context.intakeId} AND generation=${context.generation}
    AND revision=${intake.revision} AND status=${intake.status}`.execute(
    context.db
  );
  return { state: failure.retryable ? "retry" : "review" } as InvoiceWorkResult;
}

/** One invocation performs at most one paid attempt; the scheduler resumes retries. */
export async function runInvoiceIntake(
  context: InvoiceWorkerContext
): Promise<InvoiceWorkResult> {
  const intake = await getIntake(context);
  if (!intake) return { state: "missing" };
  if (
    intake.generation !== context.generation ||
    !["Queued", "Processing"].includes(intake.status)
  )
    return { state: "stale" };
  if (!(await enabled(context, intake))) return { state: "disabled" };
  const recovered = await recover(context, intake);
  if (recovered) return recovered;
  let prepared: PreparedInvoiceRequest<InvoiceExtractionEnvelope>;
  let admitted: Claim | InvoiceWorkResult;
  try {
    const { source, input } = await loadDocument(context, intake);
    prepared = context.provider.prepareExtraction(input);
    const estimate = await context.provider.estimate(prepared);
    admitted = await admit(
      context,
      intake,
      source.storagePath,
      estimate.reservedCostUsd,
      "extract"
    );
  } catch (error) {
    return failPreflight(
      context,
      intake,
      error instanceof InvoiceProviderError
        ? error
        : new InvoiceProviderError("inference_failed")
    );
  }
  if (admitted.state !== "claimed") return admitted;
  return executeClaim(context, intake, admitted, prepared);
}

async function executeClaim<
  T extends InvoiceExtractionEnvelope | InvoiceMatchSuggestions
>(
  context: InvoiceWorkerContext,
  intake: Intake,
  claim: Claim,
  prepared: PreparedInvoiceRequest<T>
) {
  if (!(await enabled(context, intake)))
    return complete(
      context,
      claim,
      undefined,
      new InvoiceProviderError("inference_paused", false, undefined, {
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0
      })
    );
  let output: InvoiceProviderResult<T>;
  try {
    output = await context.provider.execute(prepared);
  } catch (error) {
    return complete(
      context,
      claim,
      undefined,
      error instanceof InvoiceProviderError
        ? error
        : new InvoiceProviderError("inference_failed")
    );
  }
  return complete(context, claim, output);
}

/** An explicit reviewer action; suggestions share the extraction attempt budget. */
export async function runInvoiceMatch(
  context: InvoiceWorkerContext
): Promise<InvoiceWorkResult> {
  const intake = await getIntake(context);
  if (!intake) return { state: "missing" };
  if (
    intake.generation !== context.generation ||
    intake.revision !== context.revision ||
    !["NeedsReview", "Ready"].includes(intake.status)
  )
    return { state: "stale" };
  if (!(await enabled(context, intake))) return { state: "disabled" };
  let prepared: PreparedInvoiceRequest<InvoiceMatchSuggestions>;
  let admitted: Claim | InvoiceWorkResult;
  try {
    // Matching is a paid continuation of document review. It must not classify
    // deferred email facts or proceed after the selected file became unavailable.
    const { source } = await loadDocument(context, intake);
    const extractedSource = (
      await sql<{ sha256: string | null }>`
      SELECT (SELECT s.sha256 FROM public."invoiceIntakeSource" s
        WHERE s."companyId"=e."companyId" AND s."intakeId"=e."intakeId"
          AND s."storagePath"=e."storagePath" LIMIT 1) AS sha256
      FROM public."documentExtraction" e WHERE e."companyId"=${context.companyId}
        AND e."intakeId"=${context.intakeId} AND e.operation='extract' AND e.status='completed'
      ORDER BY e."createdAt" DESC,e.id DESC LIMIT 1`.execute(context.db)
    ).rows[0];
    if (extractedSource && extractedSource.sha256 !== source.sha256)
      throw new InvoiceProviderError("invoice_extraction_source_changed");

    const review = await context.db
      .selectFrom("invoiceIntake")
      .select(["supplierId", "header"])
      .where("companyId", "=", context.companyId)
      .where("id", "=", context.intakeId)
      .executeTakeFirstOrThrow();
    const lines = await context.db
      .selectFrom("invoiceIntakeLine")
      .select([
        "lineKey",
        "description",
        "supplierSku",
        "manufacturerPartNumber",
        "purchaseUnit",
        "raw"
      ])
      .where("companyId", "=", context.companyId)
      .where("intakeId", "=", context.intakeId)
      .orderBy("sortOrder")
      .limit(INVOICE_LIMITS.lines + 1)
      .execute();
    if (lines.length > INVOICE_LIMITS.lines)
      throw new InvoiceProviderError("inference_candidate_limit");
    const header = review.header as Record<string, unknown>;
    const recognition = await resolveInvoiceCandidates(
      context.db,
      context.companyId,
      {
        supplierId: review.supplierId,
        supplierName:
          typeof header.sourceSupplierName === "string"
            ? header.sourceSupplierName
            : null,
        lines
      }
    );
    const candidates = [
      ...new Map(
        recognition.lines
          .flatMap((line) => line.candidates)
          .map((item) => [item.id, item])
      ).values()
    ];
    if (
      recognition.truncated ||
      candidates.length > 100 ||
      recognition.supplierCandidates.length > 100
    )
      throw new InvoiceProviderError("inference_candidate_limit");
    const input: InvoiceMatchInput = {
      lines: lines.map((line) => ({
        ...line,
        description: line.description ?? ""
      })),
      candidates: candidates.map((item) => ({
        id: item.id,
        description: item.name,
        type: item.type,
        readableId: item.readableId
      })),
      suppliers: recognition.supplierCandidates,
      supplierName:
        typeof header.sourceSupplierName === "string"
          ? header.sourceSupplierName
          : null
    };
    prepared = context.provider.prepareMatches(input);
    const estimate = await context.provider.estimate(prepared);
    admitted = await admit(
      context,
      intake,
      `${context.companyId}/invoice-intake/${context.intakeId}/match`,
      estimate.reservedCostUsd,
      "match",
      {
        itemIds: candidates.map((item) => item.id),
        supplierIds: recognition.supplierCandidates.map(
          (supplier) => supplier.id
        ),
        lineKeys: lines.map((line) => line.lineKey)
      }
    );
  } catch (error) {
    return failPreflight(
      context,
      intake,
      error instanceof InvoiceProviderError
        ? error
        : new InvoiceProviderError("inference_failed")
    );
  }
  if (admitted.state !== "claimed") return admitted;
  return executeClaim(context, intake, admitted, prepared);
}

/** Re-dispatch durable work; completed/edited reviews never return to the queue. */
export async function pendingInvoiceIntakes(db: JobDatabase, limit = 100) {
  const result = await sql<{
    companyId: string;
    intakeId: string;
    generation: number;
  }>`SELECT i."companyId",i.id AS "intakeId",i.generation
    FROM public."invoiceIntake" i JOIN public."invoiceIntakeSettings" s ON s."companyId"=i."companyId" AND s.enabled
    LEFT JOIN public."documentExtraction" e ON e.id=i."activeExtractionId" AND e."companyId"=i."companyId"
    WHERE (i.status='Queued' OR (i.status='Processing' AND (e."leaseUntil" IS NULL OR e."leaseUntil"<now())))
      AND (i."updatedAt" IS NULL OR i."updatedAt"<now()-interval '1 minute')
    ORDER BY i."updatedAt" NULLS FIRST,i."createdAt",i.id LIMIT ${Math.max(1, Math.min(100, limit))}`.execute(
    db
  );
  return result.rows;
}
