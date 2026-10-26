<<<<<<< HEAD
import { createHash } from "node:crypto";
import type { Database, Json } from "@carbon/database";
import type { Kysely, KyselyDatabase, KyselyTx } from "@carbon/database/client";
import {
  lockCompanyInvoiceApproval,
  parseMercuryVendorSuggestion
} from "@carbon/database/mercury";
import { getNextSequence } from "@carbon/database/sequence";
import {
  getInvoiceDocumentSources,
  type InvoiceActor,
  type InvoiceIntakeStatus,
  type InvoiceItemType,
  invoiceExtractionEnvelopeSchema,
  invoiceItemTypes,
  invoiceMatchSuggestionsSchema,
  invoiceSourceReviewSchema
} from "@carbon/jobs";
import {
  persistInvoiceRecognition,
  resolveInvoiceCandidates
} from "@carbon/jobs/invoice-intake";
import { sql } from "kysely";
import { z } from "zod";
import {
  consumableValidator,
  materialValidator,
  partValidator,
  serviceValidator,
  toolValidator
} from "~/modules/items/items.models";
import {
  createReviewedItem,
  parseReviewedItemTags,
  prepareReviewedItemCreations,
  type ReviewedItemInput,
  validateReviewedCustomFields
} from "~/modules/items/items.server";
import {
  supplierContactValidator,
  supplierLocationValidator,
  supplierValidator
} from "~/modules/purchasing/purchasing.models";
import { createReviewedSupplier } from "~/modules/purchasing/purchasing.server";
import {
  getInvoiceIntakeTransition,
  getInvoicePaymentReconciliation,
  getInvoiceReviewReadiness,
  type InvoiceReviewContext,
  type InvoiceReviewIssue,
  invoiceProposalKey,
  normalizeInvoiceInboxStatus
} from "./invoice-intake.utils";
import {
  type InvoiceIntakeReview,
  type InvoiceIntakeReviewLine,
  invoiceIntakeReviewValidator,
  invoiceIntakeSettingsValidator
} from "./invoicing.models";
import { prepareCreatedPurchaseInvoice } from "./invoicing.service";

export class InvoiceIntakeError extends Error {
  constructor(
    message: string,
    public readonly code = "review_conflict"
  ) {
    super(message);
  }
}
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const evidenceFingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function rawInvoiceText(
  raw: unknown,
  field: string
): string | null | undefined {
  const source = object(raw);
  if (!(field in source)) return undefined;
  const value = object(source[field]).value;
  return typeof value === "string" ? value : null;
}
const scalarNumber = (value: string | null) =>
  value === null ? null : Number(value);
const unique = (values: (string | null | undefined)[]) => [
  ...new Set(values.filter((value): value is string => !!value))
];
type Intake = Database["public"]["Tables"]["invoiceIntake"]["Row"];
type IntakeLine = Database["public"]["Tables"]["invoiceIntakeLine"]["Row"];

export async function getInvoiceIntakePermissions(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor
) {
  const user = await db
    .selectFrom("employee as e")
    .innerJoin("user as u", "u.id", "e.id")
    .innerJoin("userPermission as p", "p.id", "e.id")
    .innerJoin("userToCompany as uc", (join) =>
      join
        .onRef("uc.userId", "=", "e.id")
        .onRef("uc.companyId", "=", "e.companyId")
    )
    .select("p.permissions")
    .where("e.id", "=", actor.userId)
    .where("e.companyId", "=", actor.companyId)
    .where("e.active", "=", true)
    .where("u.active", "=", true)
    .where("uc.role", "=", "employee")
    .executeTakeFirst();
  const permissions = object(user?.permissions);
  const can = (scope: string) =>
    Array.isArray(permissions[scope]) &&
    (permissions[scope] as unknown[]).some(
      (company) => company === actor.companyId
    );
  if (!user || !can("invoicing_view"))
    throw new InvoiceIntakeError(
      "Invoice document access is unavailable",
      "forbidden"
    );
  return {
    canUpdate: can("invoicing_update"),
    canApprove: can("invoicing_create"),
    canCreateSupplier: can("purchasing_create"),
    canCreateItemTypes: can("parts_create")
      ? [...invoiceItemTypes]
      : ([] as InvoiceItemType[]),
    canSettings: can("settings_update"),
    canUpdateSupplier: can("purchasing_update"),
    canUpdateItems: can("parts_update"),
    canAccounting: can("accounting_view")
  };
}
type Permissions = Awaited<ReturnType<typeof getInvoiceIntakePermissions>>;
function requireAbility(condition: boolean) {
  if (!condition)
    throw new InvoiceIntakeError(
      "Permission is required for this change",
      "forbidden"
    );
}
async function stampActor(trx: KyselyTx, actor: InvoiceActor) {
  await sql`SELECT set_config('request.jwt.claim.sub',${actor.userId},true)`.execute(
    trx
  );
}

function reviewFromRows(
  intake: Intake,
  lines: IntakeLine[]
): InvoiceIntakeReview {
  const header = object(intake.header);
  const meta = object(header._review);
  return invoiceIntakeReviewValidator.parse({
    documentKind: intake.documentKind,
    supplierId: intake.supplierId,
    newSupplier: intake.newSupplier,
    locationId: intake.locationId,
    paymentTermId: intake.paymentTermId,
    invoiceSupplierId: intake.invoiceSupplierId,
    invoiceSupplierContactId: intake.invoiceSupplierContactId,
    invoiceSupplierLocationId: intake.invoiceSupplierLocationId,
    purchaseInvoiceId: intake.purchaseInvoiceId,
    historical: intake.historical,
    mergeMode: meta.mergeMode ?? (intake.purchaseInvoiceId ? "enrich" : "new"),
    expectedInvoiceUpdatedAt: meta.expectedInvoiceUpdatedAt ?? null,
    header,
    lines: lines.map((line) => ({
      ...line,
      ...Object.fromEntries(
        [
          "quantity",
          "supplierUnitPrice",
          "discountAmount",
          "supplierTaxAmount",
          "taxPercent",
          "supplierShippingCost",
          "documentLineTotal",
          "conversionFactor"
        ].map((key) => [
          key,
          line[key as keyof IntakeLine] === null
            ? null
            : String(line[key as keyof IntakeLine])
        ])
      )
    }))
  });
}
async function readIntakeRows(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  id: string
) {
  const [intake, lines, sources] = await Promise.all([
    db
      .selectFrom("invoiceIntake")
      .selectAll()
      .where("id", "=", id)
      .where("companyId", "=", actor.companyId)
      .executeTakeFirst(),
    db
      .selectFrom("invoiceIntakeLine")
      .selectAll()
      .where("intakeId", "=", id)
      .where("companyId", "=", actor.companyId)
      .orderBy("sortOrder")
      .orderBy("lineKey")
      .execute(),
    db
      .selectFrom("invoiceIntakeSource")
      .selectAll()
      .where("intakeId", "=", id)
      .where("companyId", "=", actor.companyId)
      .orderBy("createdAt")
      .execute()
  ]);
  if (!intake)
    throw new InvoiceIntakeError("Invoice document not found", "not_found");
  return { intake, lines, sources, review: reviewFromRows(intake, lines) };
}
const nativeItemValidators = {
  Part: partValidator,
  Material: materialValidator,
  Consumable: consumableValidator,
  Tool: toolValidator,
  Service: serviceValidator
};

async function buildReviewContext(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  review: InvoiceIntakeReview,
  permissions: Permissions
) {
  const company = await db
    .selectFrom("company")
    .select(["baseCurrencyCode", "companyGroupId"])
    .where("id", "=", actor.companyId)
    .executeTakeFirstOrThrow();
  const itemIds = unique(review.lines.map((line) => line.itemId));
  const storageIds = unique(review.lines.map((line) => line.storageUnitId));
  const orderLineIds = unique(
    review.lines.map((line) => line.purchaseOrderLineId)
  );
  const supplierIds = unique([review.supplierId, review.invoiceSupplierId]);
  const [
    items,
    suppliers,
    units,
    locations,
    currencies,
    accounts,
    assets,
    paymentTerms,
    storageUnits,
    orderLines,
    costCenters,
    contacts,
    supplierLocations,
    customFields,
    linkedInvoice,
    invoiceLines
  ] = await Promise.all([
    itemIds.length
      ? db
          .selectFrom("item as i")
          .leftJoin("changeOrder as co", (join) =>
            join
              .onRef("co.id", "=", "i.changeOrderId")
              .onRef("co.companyId", "=", "i.companyId")
          )
          .select([
            "i.id",
            "i.type",
            "i.active",
            "i.unitOfMeasureCode",
            "i.readableId",
            "i.name",
            "i.itemTrackingType",
            "co.status as changeOrderStatus"
          ])
          .where("i.companyId", "=", actor.companyId)
          .where("i.id", "in", itemIds)
          .execute()
      : [],
    supplierIds.length
      ? db
          .selectFrom("supplier")
          .select(["id", "name", "supplierStatus"])
          .where("companyId", "=", actor.companyId)
          .where("id", "in", supplierIds)
          .execute()
      : [],
    db
      .selectFrom("unitOfMeasure")
      .select(["code", "name"])
      .where("companyId", "=", actor.companyId)
      .orderBy("code")
      .execute(),
    db
      .selectFrom("location")
      .select(["id", "name"])
      .where("companyId", "=", actor.companyId)
      .orderBy("name")
      .execute(),
    db
      .selectFrom("currency")
      .select(["code", "decimalPlaces"])
      .where("companyGroupId", "=", company.companyGroupId)
      .where("active", "=", true)
      .execute(),
    db
      .selectFrom("account")
      .select(["id", "name", "number", "active", "isGroup"])
      .where("companyGroupId", "=", company.companyGroupId)
      .execute(),
    db
      .selectFrom("fixedAsset")
      .select(["id", "name", "status"])
      .where("companyId", "=", actor.companyId)
      .execute(),
    db
      .selectFrom("paymentTerm")
      .select(["id", "name", "active"])
      .where("companyId", "=", actor.companyId)
      .execute(),
    storageIds.length
      ? db
          .selectFrom("storageUnit")
          .select(["id", "locationId", "active"])
          .where("companyId", "=", actor.companyId)
          .where("id", "in", storageIds)
          .execute()
      : [],
    orderLineIds.length
      ? db
          .selectFrom("purchaseOrderLine as l")
          .innerJoin("purchaseOrder as p", (join) =>
            join
              .onRef("p.id", "=", "l.purchaseOrderId")
              .onRef("p.companyId", "=", "l.companyId")
          )
          .select([
            "l.id",
            "l.itemId",
            "l.purchaseOrderId",
            "l.purchaseUnitOfMeasureCode",
            "l.inventoryUnitOfMeasureCode",
            "l.conversionFactor",
            "p.supplierId",
            "p.currencyCode"
          ])
          .where("l.companyId", "=", actor.companyId)
          .where("l.id", "in", orderLineIds)
          .execute()
      : [],
    db
      .selectFrom("costCenter")
      .select(["id", "name"])
      .where("companyId", "=", actor.companyId)
      .execute(),
    review.invoiceSupplierContactId
      ? db
          .selectFrom("supplierContact")
          .select(["id", "supplierId"])
          .where("id", "=", review.invoiceSupplierContactId)
          .where("companyId", "=", actor.companyId)
          .execute()
      : [],
    review.invoiceSupplierLocationId
      ? db
          .selectFrom("supplierLocation")
          .select(["id", "supplierId"])
          .where("id", "=", review.invoiceSupplierLocationId)
          .where("companyId", "=", actor.companyId)
          .execute()
      : [],
    db
      .selectFrom("customField")
      .select([
        "id",
        "name",
        "table",
        "dataTypeId",
        "required",
        "tags",
        "listOptions"
      ])
      .where("companyId", "=", actor.companyId)
      .where("active", "=", true)
      .where("table", "in", [
        "supplier",
        "part",
        "material",
        "consumable",
        "tool",
        "service"
      ])
      .execute(),
    review.purchaseInvoiceId
      ? db
          .selectFrom("purchaseInvoice")
          .selectAll()
          .select(
            sql<string>`coalesce("updatedAt","createdAt")::text`.as(
              "revisionToken"
            )
          )
          .where("id", "=", review.purchaseInvoiceId)
          .where("companyId", "=", actor.companyId)
          .executeTakeFirst()
      : undefined,
    review.purchaseInvoiceId
      ? db
          .selectFrom("purchaseInvoiceLine")
          .selectAll()
          .select(
            sql<string>`coalesce("updatedAt","createdAt")::text`.as(
              "revisionToken"
            )
          )
          .where("invoiceId", "=", review.purchaseInvoiceId)
          .where("companyId", "=", actor.companyId)
          .orderBy("sortOrder")
          .execute()
      : []
  ]);
  const duplicates =
    review.supplierId && review.header.invoiceNumber?.trim()
      ? await db
          .selectFrom("purchaseInvoice")
          .select([
            "id",
            "invoiceId",
            "supplierReference",
            "status",
            "currencyCode"
          ])
          .where("companyId", "=", actor.companyId)
          .where("supplierId", "=", review.supplierId)
          .where(
            sql<string>`lower(trim("supplierReference"))`,
            "=",
            review.header.invoiceNumber.trim().toLocaleLowerCase("en-US")
          )
          .where("status", "!=", "Voided")
          .execute()
      : review.supplierId &&
          review.header.issueDate &&
          review.header.currencyCode &&
          review.header.total
        ? (
            await sql<{
              id: string;
              invoiceId: string;
              supplierReference: string | null;
              status: string;
              currencyCode: string;
            }>`
        SELECT p.id,p."invoiceId",p."supplierReference",p.status,p."currencyCode" FROM "purchaseInvoice" p
        LEFT JOIN "purchaseInvoiceDelivery" d ON d.id=p.id AND d."companyId"=p."companyId"
        LEFT JOIN "purchaseInvoiceLine" l ON l."invoiceId"=p.id AND l."companyId"=p."companyId"
        WHERE p."companyId"=${actor.companyId} AND p."supplierId"=${review.supplierId}
          AND p."dateIssued"=${review.header.issueDate}::date AND p."currencyCode"=${review.header.currencyCode}
          AND p.status <> 'Voided'
        GROUP BY p.id,p."companyId",d."supplierShippingCost"
        HAVING round(coalesce(sum(l.quantity*l."supplierUnitPrice"+l."supplierTaxAmount"+l."supplierShippingCost"),0)
          +coalesce(d."supplierShippingCost",0),${currencies.find((row) => row.code === review.header.currencyCode)?.decimalPlaces ?? 2})
          =round(${review.header.total}::numeric,${currencies.find((row) => row.code === review.header.currencyCode)?.decimalPlaces ?? 2})`.execute(
              db
            )
          ).rows
        : [];
  const nativeErrors = (run: () => void) => {
    try {
      run();
      return [];
    } catch (error) {
      return [
        error instanceof Error ? error.message : "Complete the native form"
      ];
    }
  };
  const context: InvoiceReviewContext = {
    baseCurrencyCode: company.baseCurrencyCode ?? "",
    currencyDecimalPlaces:
      currencies.find((row) => row.code === review.header.currencyCode)
        ?.decimalPlaces ?? null,
    supportedUnits: units.map((unit) => unit.code),
    items: new Map(
      items.map((item) => [
        item.id,
        {
          ...item,
          active:
            item.active &&
            (!item.changeOrderStatus ||
              ["Done", "Cancelled"].includes(item.changeOrderStatus))
        }
      ])
    ),
    canCreateSupplier: permissions.canCreateSupplier,
    canCreateItemTypes: permissions.canCreateItemTypes,
    supplierAllowed: suppliers.some(
      (supplier) =>
        supplier.id === review.supplierId &&
        supplier.supplierStatus === "Active"
    ),
    linkedInvoiceStatus: linkedInvoice?.status ?? null,
    linkedInvoiceHasLines: invoiceLines.length > 0,
    existingFinancialLineIds: invoiceLines
      .filter(
        (line) =>
          line.invoiceLineType !== "Comment" ||
          Number(line.supplierExtendedPrice ?? 0) !== 0 ||
          Number(line.supplierTaxAmount ?? 0) !== 0 ||
          Number(line.supplierShippingCost ?? 0) !== 0
      )
      .map((line) => line.id),
    duplicateInvoiceIds: duplicates.map((invoice) => invoice.id),
    validateNewSupplier: (proposal) =>
      nativeErrors(() => {
        supplierValidator.parse(proposal.supplier);
        if (proposal.contact) supplierContactValidator.parse(proposal.contact);
        if (proposal.address) supplierLocationValidator.parse(proposal.address);
        validateReviewedCustomFields(
          customFields,
          "supplier",
          asJson(proposal.customFields ?? {})
        );
      }),
    validateNewItem: (proposal) =>
      nativeErrors(() => {
        nativeItemValidators[proposal.type].parse(proposal.data);
        validateReviewedCustomFields(
          customFields,
          proposal.type.toLowerCase(),
          asJson(proposal.customFields ?? {}),
          parseReviewedItemTags(proposal.data)
        );
      })
  };
  const extra: InvoiceReviewIssue[] = [];
  const invalid = (path: string, message: string) =>
    extra.push({ path, code: "reference", message });
  const requiredRef = (
    id: string | null,
    rows: { id: string }[],
    path: string
  ) => {
    if (id && !rows.some((row) => row.id === id))
      invalid(path, "Selected record is unavailable in this company");
  };
  requiredRef(review.supplierId, suppliers, "supplierId");
  requiredRef(review.invoiceSupplierId, suppliers, "invoiceSupplierId");
  requiredRef(review.locationId, locations, "locationId");
  requiredRef(
    review.paymentTermId,
    paymentTerms.filter((term) => term.active),
    "paymentTermId"
  );
  requiredRef(
    review.invoiceSupplierContactId,
    contacts,
    "invoiceSupplierContactId"
  );
  requiredRef(
    review.invoiceSupplierLocationId,
    supplierLocations,
    "invoiceSupplierLocationId"
  );
  const invoiceSupplierId = review.invoiceSupplierId ?? review.supplierId;
  if (contacts.some((row) => row.supplierId !== invoiceSupplierId))
    invalid(
      "invoiceSupplierContactId",
      "Contact belongs to another invoice supplier"
    );
  if (supplierLocations.some((row) => row.supplierId !== invoiceSupplierId))
    invalid(
      "invoiceSupplierLocationId",
      "Address belongs to another invoice supplier"
    );
  if (review.purchaseInvoiceId && !linkedInvoice)
    invalid(
      "purchaseInvoiceId",
      "Linked invoice is unavailable in this company"
    );
  if (
    linkedInvoice &&
    (linkedInvoice.status === "Voided" ||
      (review.supplierId && linkedInvoice.supplierId !== review.supplierId) ||
      (review.header.currencyCode &&
        linkedInvoice.currencyCode !== review.header.currencyCode))
  )
    invalid(
      "purchaseInvoiceId",
      "Linked invoice has a different supplier/currency or is voided"
    );
  const mappedIds = new Set<string>();
  review.lines.forEach((line, index) => {
    const path = `lines.${index}`;
    requiredRef(line.itemId, items, `${path}.itemId`);
    requiredRef(
      line.accountId,
      accounts.filter((account) => account.active && !account.isGroup),
      `${path}.accountId`
    );
    requiredRef(
      line.assetId,
      assets.filter(
        (asset) => review.mergeMode === "evidence" || asset.status === "Draft"
      ),
      `${path}.assetId`
    );
    requiredRef(line.locationId, locations, `${path}.locationId`);
    requiredRef(
      line.storageUnitId,
      storageUnits.filter((unit) => unit.active),
      `${path}.storageUnitId`
    );
    requiredRef(line.costCenterId, costCenters, `${path}.costCenterId`);
    requiredRef(
      line.purchaseOrderLineId,
      orderLines,
      `${path}.purchaseOrderLineId`
    );
    requiredRef(
      line.purchaseInvoiceLineId,
      invoiceLines,
      `${path}.purchaseInvoiceLineId`
    );
    if (
      line.storageUnitId &&
      storageUnits.find((unit) => unit.id === line.storageUnitId)
        ?.locationId !== line.locationId
    )
      invalid(
        `${path}.storageUnitId`,
        "Storage unit belongs to another location"
      );
    if (
      line.newItem &&
      line.stockUnit &&
      line.newItem.data.unitOfMeasureCode !== line.stockUnit
    )
      invalid(`${path}.stockUnit`, "Stock unit must match the new item");
    if (
      line.newItem?.type === "Material" &&
      Array.isArray(line.newItem.data.sizes) &&
      line.newItem.data.sizes.length > 1
    )
      invalid(
        `${path}.newItem`,
        "Propose the single material size purchased on this line"
      );
    const order = orderLines.find(
      (order) => order.id === line.purchaseOrderLineId
    );
    if (
      order &&
      (order.supplierId !== review.supplierId ||
        order.currencyCode !== review.header.currencyCode ||
        order.itemId !== line.itemId ||
        order.purchaseUnitOfMeasureCode !== line.purchaseUnit ||
        order.inventoryUnitOfMeasureCode !== line.stockUnit ||
        Number(order.conversionFactor) !== Number(line.conversionFactor))
    )
      invalid(
        `${path}.purchaseOrderLineId`,
        "Purchase order line does not match the reviewed supplier, item, currency, or units"
      );
    if (line.purchaseInvoiceLineId) {
      if (mappedIds.has(line.purchaseInvoiceLineId))
        invalid(
          `${path}.purchaseInvoiceLineId`,
          "Map each existing invoice line at most once"
        );
      mappedIds.add(line.purchaseInvoiceLineId);
      const existing = invoiceLines.find(
        (row) => row.id === line.purchaseInvoiceLineId
      );
      if (
        !line.review.expectedInvoiceLineUpdatedAt ||
        existing?.revisionToken !== line.review.expectedInvoiceLineUpdatedAt
      )
        invalid(
          `${path}.purchaseInvoiceLineId`,
          "Refresh the selected invoice line before merging"
        );
    }
  });
  const validation = getInvoiceReviewReadiness(review, context);
  validation.issues.push(...extra);
  validation.ready = validation.issues.length === 0;
  validation.status = validation.ready ? "Ready" : "NeedsReview";
  return {
    context,
    validation,
    selectionIssues: extra,
    duplicates,
    linkedInvoice,
    invoiceLines,
    options: {
      selectedSuppliers: suppliers,
      selectedItems: items,
      locations,
      units,
      currencies,
      accounts: permissions.canAccounting
        ? accounts.filter((account) => account.active && !account.isGroup)
        : [],
      assets: permissions.canAccounting
        ? assets.filter((asset) => asset.status === "Draft")
        : [],
      paymentTerms: paymentTerms.filter((term) => term.active),
      costCenters,
      customFields
    },
    orderLines,
    items
  };
}

async function getInvoiceExtraction(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  intakeId: string,
  generation: number
) {
  const attempt = await db
    .selectFrom("documentExtraction")
    .select([
      "id",
      "extractedData",
      "storagePath",
      "generation",
      "inputRevision",
      "filteredData"
    ])
    .where("companyId", "=", actor.companyId)
    .where("intakeId", "=", intakeId)
    .where("generation", "<=", generation)
    .where("operation", "=", "extract")
    .where("status", "=", "completed")
    .orderBy("generation", "desc")
    .orderBy("attemptNumber", "desc")
    .executeTakeFirst();
  const parsed = invoiceExtractionEnvelopeSchema.safeParse(
    attempt?.extractedData
  );
  return parsed.success && attempt
    ? {
        id: attempt.id,
        inputRevision: attempt.inputRevision,
        validationRevision: object(attempt.filteredData).validationRevision,
        data: parsed.data,
        storagePath: attempt.storagePath,
        generation: attempt.generation
      }
    : null;
}
async function validateSourceCoverage(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  intake: Intake,
  review: InvoiceIntakeReview,
  validation: ReturnType<typeof getInvoiceReviewReadiness>
) {
  const attempt = await getInvoiceExtraction(
    db,
    actor,
    intake.id,
    intake.generation
  );
  const sources = await db
    .selectFrom("invoiceIntakeSource")
    .select([
      "id",
      "kind",
      "sha256",
      "storagePath",
      "mercuryImportId",
      "provenance"
    ])
    .where("companyId", "=", actor.companyId)
    .where("intakeId", "=", intake.id)
    .execute();
  const eligibleSources = getInvoiceDocumentSources(sources);
  const hashes = new Set(
    eligibleSources.flatMap((source) =>
      source.sha256 && source.storagePath ? [source.sha256] : []
    )
  );
  const primary =
    review.header.primarySourceSha256 ??
    (hashes.size === 1 ? [...hashes][0]! : null);
  if (primary && hashes.has(primary))
    review.header.primarySourceSha256 = primary;
  const deferredHashes = new Set(
    sources
      .filter((source) => source.kind === "gmail")
      .map((source) => source.sha256)
  );
  const acknowledgements = review.header.sourceAcknowledgements.filter(
    (source) => !deferredHashes.has(source.sha256) || hashes.has(source.sha256)
  );
  const acknowledged = new Set(acknowledgements.map((source) => source.sha256));
  const sourceIssue = (path: string, message: string) =>
    validation.issues.push({ path, code: "source", message });
  const pendingExtractionReviewId =
    typeof object(intake.header)._pendingExtractionReview === "string"
      ? (object(intake.header)._pendingExtractionReview as string)
      : null;
  if (
    pendingExtractionReviewId &&
    review.header.extractionReviewId !== pendingExtractionReviewId
  )
    sourceIssue(
      "header.extractionReviewId",
      "Review the new extraction against your saved corrections and explicitly acknowledge it before approval"
    );
  if (!hashes.size)
    validation.issues.push({
      path: "sources",
      code: "source",
      message: "Attach the invoice or receipt before approval"
    });
  else if (!primary || !hashes.has(primary))
    sourceIssue(
      "header.primarySourceSha256",
      "Select an attached invoice or receipt as the primary source document"
    );
  if (
    acknowledged.size !== acknowledgements.length ||
    [...acknowledged].some((hash) => !hashes.has(hash))
  )
    sourceIssue(
      "header.sourceAcknowledgements",
      "Source acknowledgements must identify distinct documents attached to this intake"
    );
  if ([...hashes].some((hash) => hash !== primary && !acknowledged.has(hash)))
    sourceIssue(
      "header.sourceAcknowledgements",
      "Review each other source document and explain its supporting or excluded role for this invoice"
    );
  // A Gmail candidate may occur on several payments. Only the document that
  // was actually approved establishes invoice identity; supporting files do not.
  const sourceInvoices = primary
    ? (
        await sql<{
          id: string;
          invoiceId: string;
          supplierReference: string | null;
          status: Database["public"]["Tables"]["purchaseInvoice"]["Row"]["status"];
          currencyCode: string;
        }>`
        SELECT DISTINCT p.id,p."invoiceId",p."supplierReference",p.status,p."currencyCode"
        FROM "invoiceIntake" i
        JOIN "purchaseInvoice" p ON p.id=i."purchaseInvoiceId" AND p."companyId"=i."companyId"
        WHERE i."companyId"=${actor.companyId} AND i.id<>${intake.id}
          AND i."approvedAt" IS NOT NULL AND p.status<>'Voided'
          AND EXISTS (
            SELECT 1 FROM "invoiceIntakeSource" s
            WHERE s."companyId"=i."companyId" AND s."intakeId"=i.id AND s.sha256=${primary}
              AND s."storagePath" IS NOT NULL
          )
          AND coalesce(
            i."approvalSnapshot"#>>'{resolved,header,primarySourceSha256}',
            i.header->>'primarySourceSha256',
            (SELECT min(s.sha256) FROM "invoiceIntakeSource" s
             WHERE s."companyId"=i."companyId" AND s."intakeId"=i.id
               AND s."storagePath" IS NOT NULL AND s."createdAt"<=i."approvedAt"
             HAVING count(DISTINCT s.sha256)=1)
          )=${primary}`.execute(db)
      ).rows
    : [];
  if (sourceInvoices.some((invoice) => invoice.id !== review.purchaseInvoiceId))
    sourceIssue(
      "purchaseInvoiceId",
      "This primary document already belongs to an existing invoice; select that invoice instead of creating another"
    );
  const importIds = unique(sources.map((source) => source.mercuryImportId));
  if (primary && importIds.length > 1) {
    const unsupported = importIds.filter(
      (id) =>
        !eligibleSources.some(
          (source) =>
            source.mercuryImportId === id &&
            source.sha256 === primary &&
            !!source.storagePath
        )
    );
    const alreadyLinked =
      unsupported.length && review.purchaseInvoiceId
        ? await db
            .selectFrom("mercuryTransactionImport")
            .select("id")
            .where("companyId", "=", actor.companyId)
            .where("id", "in", unsupported)
            .where("purchaseInvoiceId", "=", review.purchaseInvoiceId)
            .execute()
        : [];
    if (unsupported.some((id) => !alreadyLinked.some((row) => row.id === id)))
      sourceIssue(
        "header.primarySourceSha256",
        "The selected primary document does not support every grouped payment; resolve their invoice associations before approval"
      );
  }
  const extractionSha256 = attempt
    ? (eligibleSources.find(
        (source) => source.storagePath === attempt.storagePath
      )?.sha256 ?? null)
    : null;
  if (
    attempt &&
    primary &&
    extractionSha256 !== primary &&
    !acknowledged.has(primary)
  )
    sourceIssue(
      "header.sourceAcknowledgements",
      "Parse the selected source document or confirm that the invoice facts were manually reviewed from that file"
    );
  // Retain earlier provenance after a failed reparse, but never treat an older
  // generation's extracted lines as the current generation's successful output.
  const extraction =
    attempt &&
    attempt.generation === intake.generation &&
    extractionSha256 === primary
      ? attempt.data
      : null;
  if (extraction && review.mergeMode !== "evidence") {
    const reviewed = new Set(review.lines.map((line) => line.lineKey));
    const expected = new Set(extraction.lines.map((line) => line.lineKey));
    const excluded = review.header.excludedLines;
    const excludedKeys = new Set(excluded.map((line) => line.lineKey));
    if (
      excludedKeys.size !== excluded.length ||
      excluded.some(
        (line) => reviewed.has(line.lineKey) || !expected.has(line.lineKey)
      ) ||
      extraction.lines.some(
        (line) => !reviewed.has(line.lineKey) && !excludedKeys.has(line.lineKey)
      )
    ) {
      validation.issues.push({
        path: "header.excludedLines",
        code: "source",
        message:
          "Review every extracted line, or explicitly exclude it with a reason"
      });
    }
    if (extraction.issues.length && !review.header.resolvedSourceIssues)
      validation.issues.push({
        path: "header.resolvedSourceIssues",
        code: "source",
        message: "Resolve the extraction warnings before approval"
      });
    validation.ready = validation.issues.length === 0;
    validation.status = validation.ready ? "Ready" : "NeedsReview";
  }
  validation.ready = validation.issues.length === 0;
  validation.status = validation.ready ? "Ready" : "NeedsReview";
  const importedPayments = importIds.length
    ? await db
        .selectFrom("mercuryTransactionImport")
        .select([
          "id",
          "amount",
          "currencyCode",
          "transactionDate",
          "remoteStatus",
          "mercuryTransactionId",
          "reference",
          "memo",
          "vendorSuggestion",
          "lastError"
        ])
        .where("companyId", "=", actor.companyId)
        .where("id", "in", importIds)
        .orderBy("transactionDate")
        .orderBy("id")
        .execute()
    : [];
  const payments = importedPayments.map((payment) => {
    const receiptAcquisition =
      parseMercuryVendorSuggestion(payment.vendorSuggestion)
        .mercuryReceiptAcquisition ?? null;
    const unresolvedAttachments = (
      receiptAcquisition?.attachments ?? []
    ).flatMap((attachment) =>
      attachment.status === "saved"
        ? []
        : [
            {
              id: attachment.id,
              fileName: attachment.fileName,
              status: attachment.status,
              fingerprint: evidenceFingerprint([
                payment.id,
                attachment.id,
                attachment.fileName,
                attachment.status,
                attachment.errorCode ?? null
              ])
            }
          ]
    );
    return {
      id: payment.id,
      amount: String(payment.amount),
      currencyCode: payment.currencyCode,
      transactionDate: payment.transactionDate,
      remoteStatus: payment.remoteStatus,
      mercuryTransactionId: payment.mercuryTransactionId,
      reference: payment.reference,
      memo: payment.memo,
      payee:
        typeof object(payment.vendorSuggestion).name === "string"
          ? (object(payment.vendorSuggestion).name as string)
          : null,
      lastErrorCode: payment.lastError,
      receiptAcquisition,
      unresolvedAttachments
    };
  });
  for (const payment of payments) {
    for (const attachment of payment.unresolvedAttachments) {
      const acknowledgements = review.header.receiptAcknowledgements.filter(
        (entry) =>
          entry.mercuryImportId === payment.id &&
          entry.attachmentId === attachment.id
      );
      if (
        acknowledgements.length !== 1 ||
        acknowledgements[0].fingerprint !== attachment.fingerprint ||
        !acknowledgements[0].reason.trim()
      )
        sourceIssue(
          "header.receiptAcknowledgements",
          "Recover each unreadable Mercury attachment or record why it has no additional invoice lines before approval"
        );
    }
    if (
      payment.receiptAcquisition &&
      payment.receiptAcquisition.attachmentCount >
        payment.receiptAcquisition.attachments.length
    )
      sourceIssue(
        "header.receiptAcknowledgements",
        "Mercury attachment collection is incomplete; collect or split the remaining attachments before approval"
      );
  }
  const paymentEvidenceFingerprint = evidenceFingerprint([
    review.header.currencyCode,
    review.header.total === null ? null : String(Number(review.header.total)),
    payments.map((payment) => [
      payment.id,
      payment.amount,
      payment.currencyCode,
      payment.remoteStatus,
      payment.transactionDate,
      payment.payee,
      payment.reference,
      payment.memo
    ])
  ]);
  const currency = review.header.currencyCode
    ? await db
        .selectFrom("currency as c")
        .innerJoin("company as co", "co.companyGroupId", "c.companyGroupId")
        .select("c.decimalPlaces")
        .where("co.id", "=", actor.companyId)
        .where("c.code", "=", review.header.currencyCode)
        .executeTakeFirst()
    : undefined;
  const paymentReconciliation = getInvoicePaymentReconciliation(
    review.header,
    payments,
    currency?.decimalPlaces ?? null
  );
  if (
    review.mergeMode !== "evidence" &&
    ["difference", "unsettled"].includes(paymentReconciliation.status) &&
    (!review.header.paymentReviewReason?.trim() ||
      review.header.paymentReviewFingerprint !== paymentEvidenceFingerprint)
  )
    sourceIssue(
      "header.paymentReviewReason",
      paymentReconciliation.status === "unsettled"
        ? "Review the bank transaction status and explain its relationship to this document before approval"
        : "Explain the difference between the linked payment and document amounts before approval"
    );
  if (paymentReconciliation.status === "currencyMismatch")
    sourceIssue(
      "header.currencyCode",
      "Payment and invoice currencies must agree before linking; review the original documents and payment association"
    );
  validation.ready = validation.issues.length === 0;
  validation.status = validation.ready ? "Ready" : "NeedsReview";
  return {
    extraction,
    sourceCoverage: { extractionSha256 },
    sourceInvoices,
    payments,
    paymentReconciliation,
    paymentEvidenceFingerprint,
    pendingExtractionReviewId,
    eligibleSourceIds: eligibleSources.map((source) => source.id),
    readinessPending:
      !!attempt &&
      intake.activeExtractionId === attempt.id &&
      attempt.generation === intake.generation &&
      intake.status === "NeedsReview" &&
      attempt.inputRevision !== null &&
      intake.revision === attempt.inputRevision + 1 &&
      attempt.validationRevision !== intake.revision
  };
}

export async function getInvoiceIntakeReview(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  id: string
) {
  const permissions = await getInvoiceIntakePermissions(db, actor);
  const rows = await readIntakeRows(db, actor, id);
  const bundle = await buildReviewContext(db, actor, rows.review, permissions);
  const {
    extraction,
    sourceCoverage,
    sourceInvoices,
    payments,
    paymentReconciliation,
    paymentEvidenceFingerprint,
    pendingExtractionReviewId,
    eligibleSourceIds,
    readinessPending
  } = await validateSourceCoverage(
    db,
    actor,
    rows.intake,
    rows.review,
    bundle.validation
  );
  const candidates = await resolveInvoiceCandidates(db, actor.companyId, {
    supplierId: rows.review.supplierId,
    supplierName: rows.review.header.sourceSupplierName,
    lines: rows.review.lines.map((line) => ({
      ...line,
      packText: rawInvoiceText(line.raw, "packText")
    }))
  });
  const rules = await db
    .selectFrom("invoiceRecognitionRule")
    .selectAll()
    .where("companyId", "=", actor.companyId)
    .where("active", "=", true)
    .where((eb) =>
      eb.or([
        ...(rows.review.supplierId
          ? [eb("supplierId", "=", rows.review.supplierId)]
          : []),
        eb("intakeId", "=", id)
      ])
    )
    .limit(500)
    .execute();
  const {
    validateNewItem: _itemValidator,
    validateNewSupplier: _supplierValidator,
    items: _items,
    ...serialContext
  } = bundle.context;
  let invoiceChoices = db
    .selectFrom("purchaseInvoice")
    .select(["id", "invoiceId", "status", "supplierReference", "currencyCode"])
    .where("companyId", "=", actor.companyId)
    .where("status", "!=", "Voided");
  if (rows.review.supplierId)
    invoiceChoices = invoiceChoices.where(
      "supplierId",
      "=",
      rows.review.supplierId
    );
  const choices = await invoiceChoices
    .orderBy("createdAt", "desc")
    .orderBy("id")
    .limit(100)
    .execute();
  if (
    bundle.linkedInvoice &&
    !choices.some((row) => row.id === bundle.linkedInvoice!.id)
  )
    choices.push(bundle.linkedInvoice);
  for (const invoice of sourceInvoices)
    if (!choices.some((row) => row.id === invoice.id)) choices.push(invoice);
  const hint = invoiceMatchSuggestionsSchema.safeParse({
    supplierId: object(rows.intake.header).modelSupplierSuggestion ?? null,
    lines: rows.lines.flatMap((line) =>
      object(line.review).modelSuggestion
        ? [object(line.review).modelSuggestion]
        : []
    )
  });
  return {
    payments,
    paymentReconciliation,
    paymentEvidenceFingerprint,
    pendingExtractionReviewId,
    eligibleSourceIds,
    readinessPending,
    modelSuggestions: hint.success ? hint.data : null,
    selectedSuppliers: bundle.options.selectedSuppliers,
    selectedItems: bundle.options.selectedItems,
    invoiceOptions: choices.map((row) => ({
      value: row.id,
      label: [row.invoiceId, row.supplierReference, row.currencyCode]
        .filter(Boolean)
        .join(" · "),
      status: row.status
    })),
    intake: rows.intake,
    review: rows.review,
    sources: rows.sources,
    validation: bundle.validation,
    duplicates: bundle.duplicates,
    linkedInvoice: bundle.linkedInvoice
      ? {
          id: bundle.linkedInvoice.id,
          status: bundle.linkedInvoice.status,
          updatedAt: bundle.linkedInvoice.revisionToken
        }
      : null,
    extraction,
    sourceCoverage,
    permissions,
    reviewContext: {
      ...serialContext,
      items: [...bundle.context.items.entries()]
    },
    locations: bundle.options.locations.map((row) => ({
      value: row.id,
      label: row.name
    })),
    units: bundle.options.units.map((row) => ({
      value: row.code,
      label: row.code + " — " + row.name
    })),
    currencies: bundle.options.currencies.map((row) => ({
      value: row.code,
      label: row.code,
      decimalPlaces: row.decimalPlaces
    })),
    accounts: bundle.options.accounts.map((row) => ({
      value: row.id,
      label: row.number + " — " + row.name
    })),
    assets: bundle.options.assets.map((row) => ({
      value: row.id,
      label: row.name
    })),
    paymentTerms: bundle.options.paymentTerms.map((row) => ({
      value: row.id,
      label: row.name
    })),
    customFields: bundle.options.customFields,
    invoiceLines: bundle.invoiceLines.map((row) => ({
      value: row.id,
      label:
        row.sortOrder + 1 + ". " + (row.description ?? row.invoiceLineType),
      updatedAt: row.revisionToken
    })),
    rules,
    candidates
  };
}

export async function getInvoiceIntakeInbox(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  input: { status?: string; offset?: number } = {}
) {
  const permissions = await getInvoiceIntakePermissions(db, actor);
  const offset = Number.isSafeInteger(input.offset)
    ? Math.max(0, Math.min(input.offset ?? 0, 1_000_000))
    : 0;
  let query = db
    .selectFrom("invoiceIntake")
    .selectAll()
    .where("companyId", "=", actor.companyId);
  const status = normalizeInvoiceInboxStatus(input.status);
  if (status === "Actionable")
    query = query.where("status", "in", [
      "NeedsReview",
      "Ready",
      "Queued",
      "Processing",
      "Failed"
    ]);
  else if (status !== "All") query = query.where("status", "=", status);
  const [intakes, settings, budget] = await Promise.all([
    query
      .orderBy("createdAt", "desc")
      .orderBy("id")
      .offset(offset)
      .limit(51)
      .execute(),
    db
      .selectFrom("invoiceIntakeSettings")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .executeTakeFirst(),
    sql<{
      todayActualUsd: string;
      todayReservedUsd: string;
      monthActualUsd: string;
      monthReservedUsd: string;
    }>`
      SELECT coalesce(sum("actualCostUsd") FILTER (WHERE "reservedAt">=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS "todayActualUsd",
        coalesce(sum("reservedCostUsd") FILTER (WHERE "actualCostUsd" IS NULL AND "reservedAt">=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS "todayReservedUsd",
        coalesce(sum("actualCostUsd"),0)::text AS "monthActualUsd",
        coalesce(sum("reservedCostUsd") FILTER (WHERE "actualCostUsd" IS NULL),0)::text AS "monthReservedUsd"
      FROM "documentExtraction" WHERE "companyId"=${actor.companyId} AND "intakeId" IS NOT NULL
        AND "reservedAt">=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`.execute(
      db
    )
  ]);
  const intakeIds = intakes.slice(0, 50).map((row) => row.id);
  const [sourceBadges, itemCounts, bankPayments] = intakeIds.length
    ? await Promise.all([
        db
          .selectFrom("invoiceIntakeSource")
          .select(["intakeId", "kind"])
          .where("companyId", "=", actor.companyId)
          .where("intakeId", "in", intakeIds)
          .execute(),
        db
          .selectFrom("invoiceIntakeLine")
          .select("intakeId")
          .select(
            sql<number>`count(DISTINCT "newItem")::integer`.as("newItems")
          )
          .where("companyId", "=", actor.companyId)
          .where("intakeId", "in", intakeIds)
          .where("newItem", "is not", null)
          .groupBy("intakeId")
          .execute(),
        db
          .selectFrom("invoiceIntakeSource as s")
          .innerJoin("mercuryTransactionImport as m", (join) =>
            join
              .onRef("m.id", "=", "s.mercuryImportId")
              .onRef("m.companyId", "=", "s.companyId")
          )
          .select([
            "s.intakeId",
            "m.id",
            "m.amount",
            "m.currencyCode",
            "m.transactionDate",
            "m.reference",
            "m.vendorSuggestion"
          ])
          .where("s.companyId", "=", actor.companyId)
          .where("s.intakeId", "in", intakeIds)
          .distinct()
          .orderBy("m.transactionDate")
          .orderBy("m.id")
          .execute()
      ])
    : [[], [], []];
  return {
    intakes: intakes.slice(0, 50).map((row) => ({
      ...row,
      payments: bankPayments
        .filter((payment) => payment.intakeId === row.id)
        .map((payment) => ({
          id: payment.id,
          amount: String(payment.amount),
          currencyCode: payment.currencyCode,
          transactionDate: payment.transactionDate,
          reference: payment.reference,
          payee:
            typeof object(payment.vendorSuggestion).name === "string"
              ? (object(payment.vendorSuggestion).name as string)
              : null
        })),
      sourceKinds: [
        ...new Set(
          sourceBadges
            .filter((source) => source.intakeId === row.id)
            .map((source) => source.kind)
        )
      ],
      newSupplierCount: row.newSupplier ? 1 : 0,
      newItemCount:
        itemCounts.find((count) => count.intakeId === row.id)?.newItems ?? 0
    })),
    hasMore: intakes.length > 50,
    settings: settings ?? null,
    budget: budget.rows[0],
    permissions,
    offset
  };
}

async function persistReview(
  trx: KyselyTx,
  actor: InvoiceActor,
  id: string,
  revision: number,
  review: InvoiceIntakeReview,
  status: "Ready" | "NeedsReview" | "NeedsDocument",
  existing: IntakeLine[]
) {
  const updated = await trx
    .updateTable("invoiceIntake")
    .set({
      documentKind: review.documentKind,
      supplierId: review.supplierId,
      newSupplier: review.newSupplier ? asJson(review.newSupplier) : null,
      purchaseInvoiceId: review.purchaseInvoiceId,
      locationId: review.locationId,
      paymentTermId: review.paymentTermId,
      invoiceSupplierId: review.invoiceSupplierId,
      invoiceSupplierContactId: review.invoiceSupplierContactId,
      invoiceSupplierLocationId: review.invoiceSupplierLocationId,
      historical: review.historical,
      header: sql<Json>`${asJson({
        ...review.header,
        _review: {
          mergeMode: review.mergeMode,
          expectedInvoiceUpdatedAt: review.expectedInvoiceUpdatedAt
        }
      })}::jsonb || CASE WHEN header ? '_defaults'
        THEN jsonb_build_object('_defaults',header->'_defaults') ELSE '{}'::jsonb END
        || CASE WHEN header ? '_pendingExtractionReview' AND (header->>'_pendingExtractionReview') IS DISTINCT FROM ${review.header.extractionReviewId}
          THEN jsonb_build_object('_pendingExtractionReview',header->'_pendingExtractionReview') ELSE '{}'::jsonb END`,
      status,
      revision: revision + 1,
      updatedBy: actor.userId,
      updatedAt: sql<string>`now()`,
      lastErrorCode: null
    })
    .where("companyId", "=", actor.companyId)
    .where("id", "=", id)
    .where("revision", "=", revision)
    .returning("revision")
    .executeTakeFirst();
  if (!updated)
    throw new InvoiceIntakeError(
      "This document changed; refresh before saving"
    );
  const old = new Map(existing.map((line) => [line.lineKey, line]));
  const lines = review.lines.map((line) => ({
    companyId: actor.companyId,
    intakeId: id,
    lineKey: line.lineKey,
    sortOrder: line.sortOrder,
    description: line.description,
    supplierSku: line.supplierSku,
    manufacturerPartNumber: line.manufacturerPartNumber,
    quantity: scalarNumber(line.quantity),
    supplierUnitPrice: scalarNumber(line.supplierUnitPrice),
    discountAmount: scalarNumber(line.discountAmount),
    supplierTaxAmount: scalarNumber(line.supplierTaxAmount),
    taxPercent: scalarNumber(line.taxPercent),
    supplierShippingCost: scalarNumber(line.supplierShippingCost),
    documentLineTotal: scalarNumber(line.documentLineTotal),
    conversionFactor: scalarNumber(line.conversionFactor),
    itemId: line.itemId,
    purchaseOrderLineId: line.purchaseOrderLineId,
    accountId: line.accountId,
    assetId: line.assetId,
    purchaseInvoiceLineId: line.purchaseInvoiceLineId,
    locationId: line.locationId,
    storageUnitId: line.storageUnitId,
    costCenterId: line.costCenterId,
    lineType: line.lineType,
    purchaseUnit: line.purchaseUnit,
    stockUnit: line.stockUnit,
    newItem: line.newItem ? asJson(line.newItem) : null,
    raw: old.get(line.lineKey)?.raw ?? {},
    review: asJson(line.review),
    createdBy: old.get(line.lineKey)?.createdBy ?? actor.userId,
    updatedBy: actor.userId,
    updatedAt: sql<string>`now()`
  }));
  if (lines.length)
    await trx
      .insertInto("invoiceIntakeLine")
      .values(lines)
      .onConflict((oc) =>
        oc.columns(["companyId", "intakeId", "lineKey"]).doUpdateSet((eb) => ({
          ...Object.fromEntries(
            Object.keys(lines[0])
              .filter(
                (key) =>
                  ![
                    "companyId",
                    "intakeId",
                    "lineKey",
                    "createdBy",
                    "raw"
                  ].includes(key)
              )
              .map((key) => [
                key,
                eb.ref(`excluded.${key}` as "excluded.description")
              ])
          )
        }))
      )
      .execute();
  let removed = trx
    .deleteFrom("invoiceIntakeLine")
    .where("companyId", "=", actor.companyId)
    .where("intakeId", "=", id);
  if (lines.length)
    removed = removed.where(
      "lineKey",
      "not in",
      lines.map((line) => line.lineKey)
    );
  await removed.execute();
  return updated.revision;
}

export async function saveInvoiceIntakeReview(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  input: { id: string; expectedRevision: number; review: unknown }
) {
  const review = invoiceIntakeReviewValidator.parse(input.review);
  requireAbility((await getInvoiceIntakePermissions(db, actor)).canUpdate);
  return db.transaction().execute(async (trx) => {
    const permissions = await getInvoiceIntakePermissions(trx, actor);
    requireAbility(permissions.canUpdate);
    await stampActor(trx, actor);
    const intake = await trx
      .selectFrom("invoiceIntake")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .where("id", "=", input.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    getInvoiceIntakeTransition(intake.status as InvoiceIntakeStatus, "save");
    if (intake.revision !== input.expectedRevision)
      throw new InvoiceIntakeError(
        "This document changed; refresh before saving"
      );
    const existing = await trx
      .selectFrom("invoiceIntakeLine")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .where("intakeId", "=", input.id)
      .execute();
    const bundle = await buildReviewContext(trx, actor, review, permissions);
    const coverage = await validateSourceCoverage(
      trx,
      actor,
      intake,
      review,
      bundle.validation
    );
    const status = coverage.eligibleSourceIds.length
      ? bundle.validation.status
      : "NeedsDocument";
    // Missing choices can be saved, but supplied foreign or invalid canonical IDs cannot.
    if (bundle.selectionIssues.length)
      throw new InvoiceIntakeError(
        "Correct invalid selected records before saving"
      );
    const revision = await persistReview(
      trx,
      actor,
      input.id,
      input.expectedRevision,
      review,
      status,
      existing
    );
    return {
      id: input.id,
      revision,
      status,
      validation: bundle.validation
    };
  });
}

/** Native defaults and interceptors run on the caller's transaction; FX is already reviewed. */
export async function createReviewedPurchaseInvoice(
  trx: KyselyTx,
  actor: InvoiceActor,
  input: { review: InvoiceIntakeReview; supplierId: string }
) {
  const { review, supplierId } = input;
  const [payment, shipping] = await Promise.all([
    trx
      .selectFrom("supplierPayment")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .where("supplierId", "=", supplierId)
      .executeTakeFirstOrThrow(),
    trx
      .selectFrom("supplierShipping")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .where("supplierId", "=", supplierId)
      .executeTakeFirstOrThrow()
  ]);
  const paymentTermId = review.paymentTermId ?? payment.paymentTermId;
  const invoiceSupplierId =
    review.invoiceSupplierId ?? payment.invoiceSupplierId ?? supplierId;
  const [term, invoiceSupplier] = await Promise.all([
    paymentTermId
      ? trx
          .selectFrom("paymentTerm")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .where("id", "=", paymentTermId)
          .where("active", "=", true)
          .executeTakeFirst()
      : null,
    trx
      .selectFrom("supplier")
      .select("id")
      .where("companyId", "=", actor.companyId)
      .where("id", "=", invoiceSupplierId)
      .executeTakeFirst()
  ]);
  if ((paymentTermId && !term) || !invoiceSupplier)
    throw new InvoiceIntakeError(
      "Correct the supplier's default payment settings before approval"
    );
  const [contact, address] = await Promise.all([
    review.invoiceSupplierContactId
      ? trx
          .selectFrom("supplierContact")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .where("id", "=", review.invoiceSupplierContactId)
          .where("supplierId", "=", invoiceSupplierId)
          .executeTakeFirst()
      : null,
    review.invoiceSupplierLocationId
      ? trx
          .selectFrom("supplierLocation")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .where("id", "=", review.invoiceSupplierLocationId)
          .where("supplierId", "=", invoiceSupplierId)
          .executeTakeFirst()
      : null
  ]);
  if (
    (review.invoiceSupplierContactId && !contact) ||
    (review.invoiceSupplierLocationId && !address)
  )
    throw new InvoiceIntakeError(
      "Choose contact and address details for the invoice supplier"
    );
  const [method, termShipping] = await Promise.all([
    shipping.shippingMethodId
      ? trx
          .selectFrom("shippingMethod")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .where("id", "=", shipping.shippingMethodId)
          .executeTakeFirst()
      : null,
    shipping.shippingTermId
      ? trx
          .selectFrom("shippingTerm")
          .select("id")
          .where("companyId", "=", actor.companyId)
          .where("id", "=", shipping.shippingTermId)
          .executeTakeFirst()
      : null
  ]);
  if (
    (shipping.shippingMethodId && !method) ||
    (shipping.shippingTermId && !termShipping)
  )
    throw new InvoiceIntakeError(
      "Correct the supplier's default shipping settings before approval"
    );
  const interaction = await trx
    .insertInto("supplierInteraction")
    .values({ companyId: actor.companyId, supplierId })
    .returning("id")
    .executeTakeFirstOrThrow();
  const invoiceId = await getNextSequence(
    trx,
    "purchaseInvoice",
    actor.companyId
  );
  const invoice = await trx
    .insertInto("purchaseInvoice")
    .values({
      ...prepareCreatedPurchaseInvoice({
        companyId: actor.companyId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
        invoiceId,
        supplierId,
        invoiceSupplierId,
        supplierInteractionId: interaction.id,
        supplierReference: review.header.invoiceNumber?.trim() || null,
        invoiceSupplierContactId: review.invoiceSupplierContactId,
        invoiceSupplierLocationId: review.invoiceSupplierLocationId,
        paymentTermId,
        currencyCode: review.header.currencyCode!,
        exchangeRate: Number(review.header.exchangeRate),
        dateIssued: review.header.issueDate,
        dateDue: review.header.dueDate,
        locationId: review.locationId,
        status: "Draft"
      }),
      exchangeRateUpdatedAt: sql<string>`now()`
    })
    .returning(["id", "invoiceId", "supplierInteractionId"])
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("purchaseInvoiceDelivery")
    .values({
      id: invoice.id,
      companyId: actor.companyId,
      locationId: review.locationId,
      shippingMethodId: shipping.shippingMethodId,
      shippingTermId: shipping.shippingTermId,
      incoterm: shipping.incoterm,
      incotermLocation: shipping.incotermLocation,
      supplierShippingCost: unallocatedShipping(review)
    })
    .execute();
  return invoice;
}
function unallocatedShipping(review: InvoiceIntakeReview) {
  return Math.max(
    0,
    Number(review.header.shipping ?? 0) -
      review.lines.reduce(
        (sum, line) => sum + Number(line.supplierShippingCost ?? 0),
        0
      )
  );
}
function authorizeReview(
  permissions: Permissions,
  review: InvoiceIntakeReview
) {
  requireAbility(permissions.canApprove && permissions.canUpdate);
  if (review.newSupplier) requireAbility(permissions.canCreateSupplier);
  if (review.lines.some((line) => line.accountId || line.assetId))
    requireAbility(permissions.canAccounting);
  for (const line of review.lines)
    if (line.newItem)
      requireAbility(
        permissions.canCreateItemTypes.includes(line.newItem.type)
      );
  if (
    review.mergeMode !== "evidence" &&
    (review.header.rememberSupplier ||
      review.lines.some(
        (line) => line.review.rememberMatch && (line.itemId || line.newItem)
      ))
  )
    requireAbility(permissions.canUpdateSupplier);
  if (review.lines.some((line) => line.review.replaceRuleId))
    requireAbility(permissions.canUpdateItems);
}
function nativeInvoiceLine(
  actor: InvoiceActor,
  invoiceId: string,
  review: InvoiceIntakeReview,
  line: InvoiceIntakeReviewLine,
  orderLines: { id: string; purchaseOrderId: string }[],
  sortOrder: number
) {
  const comment = line.lineType === "Comment";
  const typed = invoiceItemTypes.includes(line.lineType as InvoiceItemType);
  return {
    companyId: actor.companyId,
    invoiceId,
    createdBy: actor.userId,
    updatedBy: actor.userId,
    invoiceLineType: line.lineType!,
    description: line.description,
    sortOrder,
    itemId: typed ? line.itemId : null,
    accountId: line.lineType === "G/L Account" ? line.accountId : null,
    assetId: line.lineType === "Fixed Asset" ? line.assetId : null,
    purchaseOrderLineId: line.purchaseOrderLineId,
    purchaseOrderId:
      orderLines.find((order) => order.id === line.purchaseOrderLineId)
        ?.purchaseOrderId ?? null,
    quantity: comment ? 0 : Number(line.quantity),
    supplierUnitPrice: comment ? 0 : Number(line.supplierUnitPrice),
    supplierTaxAmount: comment ? 0 : Number(line.supplierTaxAmount ?? 0),
    taxPercent: comment ? 0 : Number(line.taxPercent ?? 0),
    supplierShippingCost: comment ? 0 : Number(line.supplierShippingCost ?? 0),
    exchangeRate: Number(review.header.exchangeRate),
    purchaseUnitOfMeasureCode: typed ? line.purchaseUnit : null,
    inventoryUnitOfMeasureCode: typed ? line.stockUnit : null,
    conversionFactor: typed ? Number(line.conversionFactor) : 1,
    locationId: line.locationId ?? review.locationId,
    storageUnitId: line.storageUnitId,
    costCenterId: line.costCenterId
  };
}

export async function approveInvoiceIntake(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  input: {
    intakeId: string;
    expectedRevision: number;
    approvalKey: string;
    decisions?: unknown;
  }
) {
  z.string().min(1).max(255).parse(input.approvalKey);
  const before = await readIntakeRows(db, actor, input.intakeId);
  const proposed =
    input.decisions === undefined
      ? before.review
      : invoiceIntakeReviewValidator.parse(input.decisions);
  authorizeReview(await getInvoiceIntakePermissions(db, actor), proposed);
  return db.transaction().execute(async (trx) => {
    // FIRST lock shared by both approval paths, before imports/intake/identity/native rows.
    await lockCompanyInvoiceApproval(trx, actor.companyId);
    const permissions = await getInvoiceIntakePermissions(trx, actor);
    await stampActor(trx, actor);
    const sourceImports = await trx
      .selectFrom("invoiceIntakeSource")
      .select("mercuryImportId")
      .where("companyId", "=", actor.companyId)
      .where("intakeId", "=", input.intakeId)
      .execute();
    const importIds = unique(
      sourceImports.map((row) => row.mercuryImportId)
    ).sort();
    const imports = importIds.length
      ? await trx
          .selectFrom("mercuryTransactionImport")
          .selectAll()
          .where("companyId", "=", actor.companyId)
          .where("id", "in", importIds)
          .orderBy("id")
          .forUpdate()
          .execute()
      : [];
    const intake = await trx
      .selectFrom("invoiceIntake")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .where("id", "=", input.intakeId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      intake.approvalKey === input.approvalKey &&
      intake.purchaseInvoiceId &&
      ["Approved", "Linked"].includes(intake.status)
    )
      return {
        id: intake.id,
        invoiceId: intake.purchaseInvoiceId,
        status: intake.status,
        revision: intake.revision,
        repeated: true
      };
    getInvoiceIntakeTransition(intake.status as InvoiceIntakeStatus, "save");
    if (intake.revision !== input.expectedRevision)
      throw new InvoiceIntakeError(
        "This document changed; refresh before approving"
      );
    const rows = await readIntakeRows(trx, actor, intake.id);
    if (
      JSON.stringify(
        unique(rows.sources.map((row) => row.mercuryImportId)).sort()
      ) !== JSON.stringify(importIds)
    )
      throw new InvoiceIntakeError(
        "Document sources changed; refresh before approving"
      );
    const review =
      input.decisions === undefined
        ? rows.review
        : invoiceIntakeReviewValidator.parse(input.decisions);
    authorizeReview(permissions, review);
    if (["Processing", "Queued"].includes(intake.status))
      throw new InvoiceIntakeError(
        "Wait for extraction to finish before approval"
      );
    const recipientIds = unique(
      imports.map((row) => row.mercuryRecipientId)
    ).sort();
    if (recipientIds.length)
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('mercury-recipient:' || ${actor.companyId} || ':' || value,0))
      FROM unnest(${recipientIds}::text[]) value ORDER BY value`.execute(trx);
    const mappings = recipientIds.length
      ? await trx
          .selectFrom("mercuryRecipientMapping")
          .selectAll()
          .where("companyId", "=", actor.companyId)
          .where("mercuryRecipientId", "in", recipientIds)
          .orderBy("mercuryRecipientId")
          .forUpdate()
          .execute()
      : [];
    if (review.purchaseInvoiceId) {
      await trx
        .selectFrom("purchaseInvoice")
        .select("id")
        .where("companyId", "=", actor.companyId)
        .where("id", "=", review.purchaseInvoiceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await trx
        .selectFrom("purchaseInvoiceLine")
        .select("id")
        .where("companyId", "=", actor.companyId)
        .where("invoiceId", "=", review.purchaseInvoiceId)
        .orderBy("id")
        .forUpdate()
        .execute();
    }
    const bundle = await buildReviewContext(trx, actor, review, permissions);
    const approvalEvidence = await validateSourceCoverage(
      trx,
      actor,
      intake,
      review,
      bundle.validation
    );
    if (!bundle.validation.ready)
      throw new InvoiceIntakeError(
        bundle.validation.issues
          .map((issue) => issue.message)
          .slice(0, 5)
          .join("; "),
        "review_incomplete"
      );
    if (
      review.header.currencyCode === bundle.context.baseCurrencyCode &&
      !review.header.exchangeRate
    )
      review.header.exchangeRate = "1";
    if (
      bundle.linkedInvoice &&
      review.mergeMode !== "evidence" &&
      (!review.expectedInvoiceUpdatedAt ||
        review.expectedInvoiceUpdatedAt !== bundle.linkedInvoice.revisionToken)
    )
      throw new InvoiceIntakeError(
        "The linked invoice changed; refresh and confirm its latest version"
      );
    const linkedSupplierId = bundle.linkedInvoice?.supplierId;
    const selectedSupplierId = review.supplierId ?? linkedSupplierId;
    if (mappings.some((row) => row.supplierId !== selectedSupplierId))
      throw new InvoiceIntakeError(
        "A payment recipient already belongs to a different supplier; select that supplier or correct its mapping first"
      );
    if (
      imports.some(
        (row) =>
          (row.purchaseInvoiceId &&
            row.purchaseInvoiceId !== review.purchaseInvoiceId) ||
          (row.supplierId &&
            selectedSupplierId &&
            row.supplierId !== selectedSupplierId)
      )
    )
      throw new InvoiceIntakeError(
        "A payment is already linked elsewhere; refresh and choose its existing invoice"
      );
    if (
      imports.some(
        (row) =>
          row.currencyCode !==
          (review.header.currencyCode ?? bundle.linkedInvoice?.currencyCode)
      )
    )
      throw new InvoiceIntakeError("Payment and invoice currencies must agree");
    if (
      bundle.linkedInvoice &&
      review.mergeMode === "merge" &&
      Number(bundle.linkedInvoice.exchangeRate) !==
        Number(review.header.exchangeRate) &&
      bundle.invoiceLines.some(
        (row) =>
          !review.lines.some((line) => line.purchaseInvoiceLineId === row.id)
      )
    )
      throw new InvoiceIntakeError(
        "Review every existing line before changing the invoice exchange rate"
      );
    const originalReview = asJson(review);
    let supplierId = selectedSupplierId;
    if (review.newSupplier) {
      const created = await createReviewedSupplier(trx, actor, {
        ...review.newSupplier,
        supplier: supplierValidator.parse(review.newSupplier.supplier),
        customFields: asJson(review.newSupplier.customFields ?? {})
      });
      supplierId = created.supplierId;
      review.supplierId = supplierId;
      review.newSupplier = null;
      if (!review.invoiceSupplierId) {
        review.invoiceSupplierContactId ??= created.supplierContactId ?? null;
        review.invoiceSupplierLocationId ??= created.supplierLocationId ?? null;
      }
    }
    if (!supplierId) throw new InvoiceIntakeError("Choose an invoice supplier");
    // Identical proposals create one master, with all reference reads batched before writes.
    const proposals = new Map<string, ReviewedItemInput>();
    for (const line of review.lines)
      if (line.newItem)
        proposals.set(invoiceProposalKey(line.newItem), {
          type: line.newItem.type,
          data: line.newItem.data,
          customFields: asJson(line.newItem.customFields ?? {})
        });
    const prepared = proposals.size
      ? await prepareReviewedItemCreations(trx, actor, [...proposals.values()])
      : null;
    const createdItems = new Map<
      string,
      Awaited<ReturnType<typeof createReviewedItem>>
    >();
    for (const [key, proposal] of proposals)
      createdItems.set(
        key,
        await createReviewedItem(trx, actor, proposal, prepared!)
      );
    for (const line of review.lines)
      if (line.newItem) {
        const item = createdItems.get(invoiceProposalKey(line.newItem))!;
        line.itemId = item.id;
        line.lineType = item.type as InvoiceItemType;
        line.newItem = null;
      }
    let invoiceId = bundle.linkedInvoice?.id;
    if (!invoiceId) {
      const created = await createReviewedPurchaseInvoice(trx, actor, {
        review,
        supplierId
      });
      invoiceId = created.id;
    } else if (review.mergeMode !== "evidence") {
      await trx
        .updateTable("purchaseInvoice")
        .set({
          supplierReference: review.header.invoiceNumber?.trim() || null,
          dateIssued: review.header.issueDate,
          dateDue: review.header.dueDate,
          currencyCode: review.header.currencyCode!,
          exchangeRate: Number(review.header.exchangeRate),
          exchangeRateUpdatedAt: sql<string>`now()`,
          locationId: review.locationId,
          ...(review.paymentTermId
            ? { paymentTermId: review.paymentTermId }
            : {}),
          ...(review.invoiceSupplierId
            ? { invoiceSupplierId: review.invoiceSupplierId }
            : {}),
          ...(review.invoiceSupplierContactId
            ? { invoiceSupplierContactId: review.invoiceSupplierContactId }
            : {}),
          ...(review.invoiceSupplierLocationId
            ? { invoiceSupplierLocationId: review.invoiceSupplierLocationId }
            : {}),
          updatedBy: actor.userId,
          updatedAt: sql<string>`now()`
        })
        .where("companyId", "=", actor.companyId)
        .where("id", "=", invoiceId)
        .where("status", "=", "Draft")
        .execute();
      await trx
        .updateTable("purchaseInvoiceDelivery")
        .set({
          locationId: review.locationId,
          supplierShippingCost: unallocatedShipping(review)
        })
        .where("companyId", "=", actor.companyId)
        .where("id", "=", invoiceId)
        .execute();
    }
    review.purchaseInvoiceId = invoiceId;
    review.supplierId = supplierId;
    if (review.mergeMode !== "evidence") {
      let nextOrder =
        Math.max(-1, ...bundle.invoiceLines.map((line) => line.sortOrder)) + 1;
      const added: {
        line: InvoiceIntakeReviewLine;
        payload: ReturnType<typeof nativeInvoiceLine>;
      }[] = [];
      for (const line of [...review.lines].sort(
        (a, b) => a.sortOrder - b.sortOrder
      )) {
        if (line.purchaseInvoiceLineId) {
          const existing = bundle.invoiceLines.find(
            (row) => row.id === line.purchaseInvoiceLineId
          )!;
          const {
            createdBy: _createdBy,
            companyId: _companyId,
            invoiceId: _invoiceId,
            ...payload
          } = nativeInvoiceLine(
            actor,
            invoiceId,
            review,
            line,
            bundle.orderLines,
            existing.sortOrder
          );
          await trx
            .updateTable("purchaseInvoiceLine")
            .set({ ...payload, updatedAt: sql<string>`now()` })
            .where("companyId", "=", actor.companyId)
            .where("id", "=", existing.id)
            .where("invoiceId", "=", invoiceId)
            .execute();
        } else
          added.push({
            line,
            payload: nativeInvoiceLine(
              actor,
              invoiceId,
              review,
              line,
              bundle.orderLines,
              nextOrder++
            )
          });
      }
      if (added.length) {
        const inserted = await trx
          .insertInto("purchaseInvoiceLine")
          .values(added.map((row) => row.payload))
          .returning(["id", "sortOrder"])
          .execute();
        const ids = new Map(inserted.map((row) => [row.sortOrder, row.id]));
        for (const row of added)
          row.line.purchaseInvoiceLineId = ids.get(row.payload.sortOrder)!;
      }
      const sourceRows = new Map(
        rows.lines.map((line) => [line.lineKey, line])
      );
      await persistInvoiceRecognition(trx, actor, {
        intakeId: intake.id,
        supplierId,
        supplierName: review.header.sourceSupplierName,
        rememberSupplier: review.header.rememberSupplier,
        lines: review.lines.flatMap((line) =>
          line.itemId && line.purchaseUnit && line.stockUnit
            ? [
                {
                  ...line,
                  itemId: line.itemId,
                  purchaseUnit: line.purchaseUnit,
                  stockUnit: line.stockUnit,
                  packText: rawInvoiceText(
                    sourceRows.get(line.lineKey)?.raw,
                    "packText"
                  ),
                  rawDescription: rawInvoiceText(
                    sourceRows.get(line.lineKey)?.raw,
                    "description"
                  ),
                  rawPurchaseUnit: rawInvoiceText(
                    sourceRows.get(line.lineKey)?.raw,
                    "purchaseUnit"
                  ),
                  rawSupplierSku: rawInvoiceText(
                    sourceRows.get(line.lineKey)?.raw,
                    "supplierSku"
                  ),
                  rawManufacturerPartNumber: rawInvoiceText(
                    sourceRows.get(line.lineKey)?.raw,
                    "manufacturerPartNumber"
                  ),
                  conversionFactor: Number(line.conversionFactor),
                  remember: line.review.rememberMatch,
                  replaceRuleId: line.review.replaceRuleId,
                  replacementReason: line.review.replacementReason
                }
              ]
            : []
        )
      });
    }
    const missingMappings = recipientIds.filter(
      (id) => !mappings.some((mapping) => mapping.mercuryRecipientId === id)
    );
    if (missingMappings.length)
      await trx
        .insertInto("mercuryRecipientMapping")
        .values(
          missingMappings.map((mercuryRecipientId) => ({
            companyId: actor.companyId,
            mercuryRecipientId,
            supplierId,
            createdBy: actor.userId,
            updatedBy: actor.userId
          }))
        )
        .execute();
    if (importIds.length)
      await trx
        .updateTable("mercuryTransactionImport")
        .set({
          supplierId,
          purchaseInvoiceId: invoiceId,
          reviewStatus: "Imported",
          lastError: null,
          updatedBy: actor.userId,
          updatedAt: sql<string>`now()`
        })
        .where("companyId", "=", actor.companyId)
        .where("id", "in", importIds)
        .execute();
    const revision = await persistReview(
      trx,
      actor,
      intake.id,
      intake.revision,
      review,
      "Ready",
      rows.lines
    );
    const status = review.mergeMode === "evidence" ? "Linked" : "Approved";
    await trx
      .updateTable("invoiceIntake")
      .set({
        status,
        approvalKey: input.approvalKey,
        approvalSnapshot: asJson({
          sourceSha256s: unique(
            getInvoiceDocumentSources(rows.sources).map(
              (source) => source.sha256
            )
          ).sort(),
          payments: approvalEvidence.payments,
          paymentReconciliation: approvalEvidence.paymentReconciliation,
          review: originalReview,
          resolved: review,
          defaultSources: object(intake.header)._defaults ?? null,
          invoiceId,
          supplierId
        }),
        approvedBy: actor.userId,
        approvedAt: sql<string>`now()`,
        attachmentStatus:
          getInvoiceDocumentSources(rows.sources).length > 0
            ? "Pending"
            : "None"
      })
      .where("companyId", "=", actor.companyId)
      .where("id", "=", intake.id)
      .execute();
    return { id: intake.id, invoiceId, status, revision, repeated: false };
  });
}

export async function setInvoiceIntakeStatus(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  input: {
    id: string;
    expectedRevision: number;
    action: "ignore" | "restore" | "retry";
  }
) {
  requireAbility((await getInvoiceIntakePermissions(db, actor)).canUpdate);
  return db.transaction().execute(async (trx) => {
    await lockCompanyInvoiceApproval(trx, actor.companyId);
    const sources = await trx
      .selectFrom("invoiceIntakeSource")
      .select("mercuryImportId")
      .where("companyId", "=", actor.companyId)
      .where("intakeId", "=", input.id)
      .execute();
    const importIds = unique(sources.map((row) => row.mercuryImportId)).sort();
    if (importIds.length)
      await trx
        .selectFrom("mercuryTransactionImport")
        .select("id")
        .where("companyId", "=", actor.companyId)
        .where("id", "in", importIds)
        .orderBy("id")
        .forUpdate()
        .execute();
    requireAbility((await getInvoiceIntakePermissions(trx, actor)).canUpdate);
    await stampActor(trx, actor);
    const intake = await trx
      .selectFrom("invoiceIntake")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .where("id", "=", input.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (intake.revision !== input.expectedRevision)
      throw new InvoiceIntakeError(
        "This document changed; refresh before continuing"
      );
    let status = getInvoiceIntakeTransition(
      intake.status as InvoiceIntakeStatus,
      input.action
    );
    if (input.action === "retry" || input.action === "restore") {
      const sources = await trx
        .selectFrom("invoiceIntakeSource")
        .select("sha256")
        .where("kind", "!=", "gmail")
        .where(sql<boolean>`coalesce(provenance->>'current','true') <> 'false'`)
        .where("companyId", "=", actor.companyId)
        .where("intakeId", "=", input.id)
        .where("storagePath", "is not", null)
        .execute();
      if (!sources.length) status = "NeedsDocument";
      else if (input.action === "retry") {
        const selection = invoiceSourceReviewSchema.parse(intake.header);
        const hashes = new Set(sources.map((source) => source.sha256));
        const primary =
          selection.primarySourceSha256 ??
          (hashes.size === 1 ? [...hashes][0] : null);
        if (!primary || !hashes.has(primary))
          throw new InvoiceIntakeError(
            "Save a primary source document selection before parsing again"
          );
      }
    }
    if (input.action === "restore" && importIds.length)
      await trx
        .updateTable("mercuryTransactionImport")
        .set({
          reviewStatus: sql<string>`CASE WHEN "purchaseInvoiceId" IS NULL THEN 'Pending' ELSE 'Imported' END`,
          updatedBy: actor.userId,
          updatedAt: sql<string>`now()`
        })
        .where("companyId", "=", actor.companyId)
        .where("id", "in", importIds)
        .where("reviewStatus", "=", "Ignored")
        .execute();
    const updated = await trx
      .updateTable("invoiceIntake")
      .set({
        status,
        revision: intake.revision + 1,
        ...(input.action === "retry"
          ? { generation: intake.generation + 1, activeExtractionId: null }
          : {}),
        updatedBy: actor.userId,
        updatedAt: sql<string>`now()`,
        lastErrorCode: null
      })
      .where("companyId", "=", actor.companyId)
      .where("id", "=", input.id)
      .returning(["id", "status", "revision", "generation"])
      .executeTakeFirstOrThrow();
    return updated;
  });
}

export async function saveInvoiceIntakeSettings(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  input: unknown
) {
  const settings = invoiceIntakeSettingsValidator.parse(input);
  requireAbility((await getInvoiceIntakePermissions(db, actor)).canSettings);
  return db.transaction().execute(async (trx) => {
    requireAbility((await getInvoiceIntakePermissions(trx, actor)).canSettings);
    await stampActor(trx, actor);
    return trx
      .insertInto("invoiceIntakeSettings")
      .values({
        ...settings,
        companyId: actor.companyId,
        createdBy: actor.userId,
        updatedBy: actor.userId
      })
      .onConflict((oc) =>
        oc.column("companyId").doUpdateSet({
          ...settings,
          updatedBy: actor.userId,
          updatedAt: sql<string>`now()`
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export async function updateInvoiceRecognitionRule(
  db: Kysely<KyselyDatabase>,
  actor: InvoiceActor,
  input: {
    id: string;
    action: "disable" | "replace";
    expectedVersion: number;
    supplierId?: string;
    reason?: string;
  }
) {
  const parsed = z
    .object({
      id: z.string().min(1),
      action: z.enum(["disable", "replace"]),
      expectedVersion: z.number().int().positive(),
      supplierId: z.string().min(1).optional(),
      reason: z.string().trim().max(1000).optional()
    })
    .parse(input);
  const initial = await getInvoiceIntakePermissions(db, actor);
  requireAbility(initial.canUpdate && initial.canUpdateSupplier);
  return db.transaction().execute(async (trx) => {
    await lockCompanyInvoiceApproval(trx, actor.companyId);
    const permissions = await getInvoiceIntakePermissions(trx, actor);
    requireAbility(permissions.canUpdate && permissions.canUpdateSupplier);
    await stampActor(trx, actor);
    const current = await trx
      .selectFrom("invoiceRecognitionRule")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .where("id", "=", parsed.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!current.active || current.version !== parsed.expectedVersion)
      throw new InvoiceIntakeError(
        "This saved match changed; refresh before continuing"
      );
    if (current.kind === "itemAlias")
      requireAbility(permissions.canUpdateItems);
    if (parsed.action === "replace") {
      if (current.kind !== "supplierAlias")
        throw new InvoiceIntakeError(
          "Replace item identity and pack conversion in the document review before approval"
        );
      if (!parsed.supplierId || !parsed.reason)
        throw new InvoiceIntakeError(
          "Choose the replacement supplier and enter a reason"
        );
      const supplier = await trx
        .selectFrom("supplier")
        .select("id")
        .where("companyId", "=", actor.companyId)
        .where("id", "=", parsed.supplierId)
        .where("supplierStatus", "=", "Active")
        .executeTakeFirst();
      if (!supplier)
        throw new InvoiceIntakeError(
          "Choose an active supplier in this company"
        );
      if (supplier.id === current.supplierId)
        throw new InvoiceIntakeError(
          "Choose a different supplier to replace this match"
        );
    }
    await trx
      .updateTable("invoiceRecognitionRule")
      .set({
        active: false,
        updatedBy: actor.userId,
        updatedAt: sql<string>`now()`
      })
      .where("companyId", "=", actor.companyId)
      .where("id", "=", current.id)
      .execute();
    if (parsed.action === "disable")
      return { id: current.id, active: false, version: current.version };
    return trx
      .insertInto("invoiceRecognitionRule")
      .values({
        companyId: actor.companyId,
        kind: "supplierAlias",
        matchKey: current.matchKey,
        sourceText: JSON.stringify({
          source: current.sourceText,
          replacementReason: parsed.reason
        }),
        supplierId: parsed.supplierId!,
        version: current.version + 1,
        supersedesId: current.id,
        intakeId: current.intakeId,
        createdBy: actor.userId
      })
      .returning(["id", "active", "version"])
      .executeTakeFirstOrThrow();
  });
}

/** ERP-owned readiness after durable extraction; stale callbacks never replace operator edits. */
export async function validateHydratedInvoiceIntake(input: {
  db: Kysely<KyselyDatabase>;
  companyId: string;
  intakeId: string;
  userId: string;
  generation: number;
  expectedRevision: number;
  attemptId: string;
}): Promise<{ validated: boolean; revision?: number }> {
  const actor = { companyId: input.companyId, userId: input.userId };
  return input.db.transaction().execute(async (trx) => {
    await lockCompanyInvoiceApproval(trx, actor.companyId);
    const intake = await trx
      .selectFrom("invoiceIntake")
      .selectAll()
      .where("companyId", "=", actor.companyId)
      .where("id", "=", input.intakeId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !intake ||
      intake.status !== "NeedsReview" ||
      intake.revision !== input.expectedRevision ||
      intake.generation !== input.generation ||
      intake.activeExtractionId !== input.attemptId
    )
      return { validated: false };
    const attempt = await trx
      .selectFrom("documentExtraction")
      .select(["id", "inputRevision"])
      .where("companyId", "=", actor.companyId)
      .where("intakeId", "=", intake.id)
      .where("generation", "=", input.generation)
      .where("id", "=", input.attemptId)
      .where("status", "=", "completed")
      .executeTakeFirst();
    if (
      !attempt ||
      attempt.inputRevision === null ||
      attempt.inputRevision + 1 !== input.expectedRevision
    )
      return { validated: false };
    const permissions = await getInvoiceIntakePermissions(trx, actor);
    requireAbility(permissions.canUpdate);
    await stampActor(trx, actor);
    const rows = await readIntakeRows(trx, actor, intake.id);
    const review = rows.review;
    const [payment, job] = await Promise.all([
      review.supplierId
        ? trx
            .selectFrom("supplierPayment")
            .selectAll()
            .where("companyId", "=", actor.companyId)
            .where("supplierId", "=", review.supplierId)
            .executeTakeFirst()
        : undefined,
      trx
        .selectFrom("employeeJob as j")
        .innerJoin("location as l", (join) =>
          join
            .onRef("l.id", "=", "j.locationId")
            .onRef("l.companyId", "=", "j.companyId")
        )
        .select("l.id")
        .where("j.companyId", "=", actor.companyId)
        .where("j.id", "=", actor.userId)
        .executeTakeFirst()
    ]);
    const defaults: Record<string, string> = {};
    if (!review.locationId && job) {
      review.locationId = job.id;
      defaults.locationId = "employeeJob";
    }
    const billingId =
      review.invoiceSupplierId ??
      payment?.invoiceSupplierId ??
      review.supplierId;
    const [billing, term, contact, address] = await Promise.all([
      billingId
        ? trx
            .selectFrom("supplier")
            .select("id")
            .where("companyId", "=", actor.companyId)
            .where("id", "=", billingId)
            .executeTakeFirst()
        : undefined,
      payment?.paymentTermId
        ? trx
            .selectFrom("paymentTerm")
            .select("id")
            .where("companyId", "=", actor.companyId)
            .where("id", "=", payment.paymentTermId)
            .where("active", "=", true)
            .executeTakeFirst()
        : undefined,
      billingId && payment?.invoiceSupplierContactId
        ? trx
            .selectFrom("supplierContact")
            .select("id")
            .where("companyId", "=", actor.companyId)
            .where("id", "=", payment.invoiceSupplierContactId)
            .where("supplierId", "=", billingId)
            .executeTakeFirst()
        : undefined,
      billingId && payment?.invoiceSupplierLocationId
        ? trx
            .selectFrom("supplierLocation")
            .select("id")
            .where("companyId", "=", actor.companyId)
            .where("id", "=", payment.invoiceSupplierLocationId)
            .where("supplierId", "=", billingId)
            .executeTakeFirst()
        : undefined
    ]);
    if (!review.invoiceSupplierId && billing) {
      review.invoiceSupplierId = billing.id;
      defaults.invoiceSupplierId = "supplierPayment";
    }
    if (!review.paymentTermId && term) {
      review.paymentTermId = term.id;
      defaults.paymentTermId = "supplierPayment";
    }
    if (!review.invoiceSupplierContactId && contact) {
      review.invoiceSupplierContactId = contact.id;
      defaults.invoiceSupplierContactId = "supplierPayment";
    }
    if (!review.invoiceSupplierLocationId && address) {
      review.invoiceSupplierLocationId = address.id;
      defaults.invoiceSupplierLocationId = "supplierPayment";
    }
    const ids = unique(review.lines.map((line) => line.itemId));
    const items = ids.length
      ? await trx
          .selectFrom("item as i")
          .innerJoin("unitOfMeasure as u", (join) =>
            join
              .onRef("u.code", "=", "i.unitOfMeasureCode")
              .onRef("u.companyId", "=", "i.companyId")
          )
          .select(["i.id", "i.type", "u.code"])
          .where("i.companyId", "=", actor.companyId)
          .where("i.id", "in", ids)
          .where("i.active", "=", true)
          .execute()
      : [];
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const line of review.lines) {
      const item = line.itemId ? byId.get(line.itemId) : null;
      if (item && !line.stockUnit) {
        line.stockUnit = item.code;
        defaults[`lines.${line.lineKey}.stockUnit`] = "item";
      }
      if (
        item &&
        !line.lineType &&
        invoiceItemTypes.includes(item.type as InvoiceItemType)
      ) {
        line.lineType = item.type as InvoiceItemType;
        defaults[`lines.${line.lineKey}.lineType`] = "item";
      }
      if (
        !line.conversionFactor &&
        line.purchaseUnit &&
        line.purchaseUnit === line.stockUnit
      ) {
        line.conversionFactor = "1";
        defaults[`lines.${line.lineKey}.conversionFactor`] = "identicalUnits";
      }
      if (!line.locationId && review.locationId) {
        line.locationId = review.locationId;
        defaults[`lines.${line.lineKey}.locationId`] = "invoiceLocation";
      }
    }
    const bundle = await buildReviewContext(trx, actor, review, permissions);
    await validateSourceCoverage(trx, actor, intake, review, bundle.validation);
    if (
      bundle.linkedInvoice?.status === "Draft" &&
      bundle.invoiceLines.length === 0 &&
      !review.expectedInvoiceUpdatedAt
    ) {
      review.expectedInvoiceUpdatedAt = bundle.linkedInvoice.revisionToken;
      defaults.expectedInvoiceUpdatedAt = "emptyDraft";
    }
    // Worker auto-confirmation is limited to explicit zero charges and exact source
    // arithmetic. Missing/positive/unallocated charges retain the normal review gate.
    const revision = await persistReview(
      trx,
      actor,
      intake.id,
      intake.revision,
      review,
      bundle.validation.status,
      rows.lines
    );
    if (Object.keys(defaults).length)
      await trx
        .updateTable("invoiceIntake")
        .set({
          header: sql`header || jsonb_build_object('_defaults',${JSON.stringify(defaults)}::jsonb)`
        })
        .where("companyId", "=", actor.companyId)
        .where("id", "=", intake.id)
        .execute();
    return { validated: true, revision };
  });
}
||||||| 85d9006e1
=======
// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { defineServiceFn } from "@carbon/api/service-fn.server";
import { paged, payload, unwrap } from "@carbon/api/service-tools.server";
import {
  dedupeViolations,
  evaluateSalesRulesForSalesDocument,
  isBlocked,
  resolveSalesInvoiceShipTo,
  resolveSalesOrderShipTo
} from "@carbon/ee/rules.server";
import { storage } from "@carbon/files";
import { trigger } from "@carbon/jobs";
import { checkPartyContactRequirement } from "@carbon/lib/party-contact.server";
import { trackWorkEvent } from "@carbon/lib/telemetry";
import { raiseMoment } from "@carbon/lib/workflows";
import { getLogger } from "@carbon/logger";
import { datetime, deriveRate, taxableBase, toBaseAmount } from "@carbon/utils";
import { z } from "zod";
import { upsertDocument } from "~/modules/documents/documents.service";
import {
  resolveItemIdFromExtractedText,
  upsertPart
} from "~/modules/items/items.service";
import {
  deletePurchaseInvoiceLineReleasingLeases,
  deletePurchaseInvoiceReleasingLeases
} from "~/modules/purchasing/purchasing.service";
import {
  deleteRentalCreditMemoReleasingPeriods,
  deleteSalesInvoiceLineReleasingRentals,
  deleteSalesInvoiceReleasingRentals,
  recordSalesRuleOutcome
} from "~/modules/sales/sales.service";
import {
  getCompanySettings,
  getNextSequence
} from "~/modules/settings/settings.service";
import { refuseUnlessOwned } from "~/modules/shared/shared.service";
import { stripSpecialCharacters } from "~/utils/string";
import * as accountingPostings from "../accounting/accounting.service";
import * as purchasingPostings from "../purchasing/purchasing.service";
import { fromServerFn, invokePosting } from "../shared/shared.service";
import {
  isMemoLocked,
  paymentValidator,
  purchaseInvoiceSupplierChange,
  purchaseInvoiceValidator,
  reimbursementLinesValidator,
  reimbursementPaymentValidator,
  reimbursementUpdateValidator,
  salesInvoiceCustomerChange,
  salesInvoiceLineValidator,
  salesInvoicePostValidator
} from "./invoicing.models";
import type { SalesRuleCheck, StripeSendContext } from "./invoicing.service";
import * as service from "./invoicing.service";

const logger = getLogger("erp", "invoicing");

// --- Shared -------------------------------------------------------------------

const customFieldValues = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()])
);
// --- Sales invoices -----------------------------------------------------------
const salesInvoiceFields = [
  "invoiceCustomerId",
  "customerId",
  "dateIssued",
  "paymentTermId",
  "currencyCode",
  "invoiceCustomerContactId",
  "invoiceCustomerLocationId",
  "locationId",
  "customerReference",
  "exchangeRate",
  "dateDue",
  "datePaid"
] as const;

/**
 * Set one field on one or more sales invoices.
 *
 * @remarks
 * Refused when any of the invoices is posted, except for the issue, due and
 * paid dates. A new invoice customer brings its currency at today's rate
 * (a customer with none keeps the invoice's) and clears the invoice contact
 * and address. A new customer clears the ship-to of each invoice whose
 * customer changes. A new issue date or payment term on a single invoice
 * recomputes its due date; with several invoices nothing is written. A new
 * currency brings today's exchange rate. An empty value clears the field.
 */
export const updateSalesInvoiceField = defineServiceFn({
  input: service.fieldUpdate(salesInvoiceFields),
  permission: { update: "sales" },

  async run(ctx, { ids, field, value }) {
    const client = ctx.asCaller.supabase;
    const companyId = ctx.company.id;
    const locked = await service.refuseLockedInvoices(
      ctx,
      "salesInvoice",
      ids,
      field,
      "Cannot modify a locked sales invoice."
    );
    if (locked) return locked;
    const audit = {
      updatedBy: ctx.auditUserId,
      updatedAt: datetime.timestamp()
    };

    if (field === "invoiceCustomerId") {
      if (!value)
        return ctx.error("validation", "Invoice customer is required");
      const currency = await service.partyCurrency(ctx, "customer", value);
      if (currency instanceof Error) return currency;
      const update = await client
        .from("salesInvoice")
        .update({ ...salesInvoiceCustomerChange(value, currency), ...audit })
        .in("id", ids)
        .eq("companyId", companyId);
      if (update.error) {
        return ctx.error(
          "internal",
          "Failed to update the invoices",
          update.error
        );
      }
      return { ids };
    }

    if (field === "customerId") {
      // A ship-to is one of the old customer's locations, so a customer
      // change clears it (sales rules would otherwise evaluate an address
      // that is not the new customer's).
      if (value) {
        const changed = await client
          .from("salesInvoice")
          .select("id")
          .in("id", ids)
          .eq("companyId", companyId)
          .neq("customerId", value);
        if (changed.error) {
          return ctx.error(
            "internal",
            "Failed to load the invoices",
            changed.error
          );
        }
        const changedIds = changed.data.map((row) => row.id);
        if (changedIds.length > 0) {
          const cleared = await client
            .from("salesInvoiceShipment")
            .update({ customerLocationId: null, ...audit })
            .in("id", changedIds)
            .eq("companyId", companyId);
          if (cleared.error) {
            return ctx.error(
              "internal",
              "Failed to clear the ship-to",
              cleared.error
            );
          }
        }
      }
      const update = await client
        .from("salesInvoice")
        .update({ customerId: value || undefined, ...audit })
        .in("id", ids)
        .eq("companyId", companyId);
      if (update.error) {
        return ctx.error(
          "internal",
          "Failed to update the invoices",
          update.error
        );
      }
      return { ids };
    }

    return service.writeInvoiceField(ctx, "salesInvoice", {
      ids,
      field,
      value
    });
  }
});
const salesInvoiceLineInput = salesInvoiceLineValidator.safeExtend({
  customFields: customFieldValues.optional(),
  acknowledged: z.boolean().default(false)
});

/**
 * Add a line to a sales invoice.
 *
 * @remarks
 * Refused while the invoice is posted. `discountPercent` is in percent points
 * (0–100). A line with an item is first checked against the sales rules at
 * the invoice's ship-to (none is assumed when the invoice has none): an
 * error, or a warning not `acknowledged`, returns `violations` and adds
 * nothing.
 *
 * @mcp
 */
export const createSalesInvoiceLine = defineServiceFn({
  input: salesInvoiceLineInput,
  permission: { create: "invoicing" },

  async run(ctx, { id: _id, acknowledged, customFields, ...input }) {
    const line = service.salesInvoiceLineRow(input);
    const locked = await service.unlockedSalesInvoice(
      ctx,
      line.invoiceId,
      "Cannot modify a locked sales invoice. Reopen it first."
    );
    if (locked) return locked;

    let check: SalesRuleCheck = { violations: [], ruleNames: {} };
    if (line.itemId) {
      // A standalone line has no order, so the invoice's own ship-to.
      const shipTo = await resolveSalesInvoiceShipTo(
        ctx.asSystem.supabase,
        line.invoiceId,
        ctx.company.id
      );
      const gate = await service.salesInvoiceLineGate(ctx, {
        invoiceId: line.invoiceId,
        lineId: null,
        itemId: line.itemId,
        quantity: line.quantity ?? 1,
        shipTo,
        acknowledged
      });
      if (gate.blocked) return gate.blocked;
      check = gate.check;
    }

    const created = await service.upsertSalesInvoiceLine(
      ctx.asCaller.supabase,
      {
        ...line,
        companyId: ctx.company.id,
        createdBy: ctx.auditUserId,
        customFields
      }
    );
    if (created.error) {
      return ctx.error(
        "internal",
        "Failed to create sales invoice line.",
        created.error
      );
    }

    if (line.itemId && check.violations.length > 0) {
      await service.recordSalesInvoiceLineOutcome(
        ctx,
        {
          invoiceId: line.invoiceId,
          lineId: created.data.id,
          itemId: line.itemId
        },
        "acknowledged",
        check
      );
    }
    return { salesInvoiceLineId: created.data.id };
  }
});

/**
 * Change a sales invoice line.
 *
 * @remarks
 * Refused while the invoice is posted, and for a line that is not on
 * `invoiceId`. A line with an item is first checked against the sales rules
 * (see `createSalesInvoiceLine`); a line converted from a sales order is
 * checked at that order's ship-to.
 *
 * @mcp
 */
export const updateSalesInvoiceLine = defineServiceFn({
  input: salesInvoiceLineInput.safeExtend({ id: z.string() }),
  permission: { create: "invoicing" },

  async run(ctx, { id, acknowledged, customFields, ...input }) {
    const line = service.salesInvoiceLineRow(input);
    const refused = await refuseUnlessOwned(ctx, "salesInvoiceLine", {
      id,
      invoiceId: line.invoiceId
    });
    if (refused) return refused;
    const locked = await service.unlockedSalesInvoice(
      ctx,
      line.invoiceId,
      "Cannot modify a locked sales invoice. Reopen it first."
    );
    if (locked) return locked;

    let check: SalesRuleCheck = { violations: [], ruleNames: {} };
    if (line.itemId) {
      const serviceRole = ctx.asSystem.supabase;
      const existing = await serviceRole
        .from("salesInvoiceLine")
        .select("salesOrderId")
        .eq("id", id)
        .eq("companyId", ctx.company.id)
        .maybeSingle();
      if (existing.error) {
        // A failed read must not evaluate the wrong destination.
        return ctx.error(
          "internal",
          "Failed to load the sales invoice line",
          existing.error
        );
      }
      // An order's line ships where the order does (drop-ship included).
      const shipTo = existing.data?.salesOrderId
        ? await resolveSalesOrderShipTo(
            serviceRole,
            existing.data.salesOrderId,
            ctx.company.id
          )
        : await resolveSalesInvoiceShipTo(
            serviceRole,
            line.invoiceId,
            ctx.company.id
          );
      const gate = await service.salesInvoiceLineGate(ctx, {
        invoiceId: line.invoiceId,
        lineId: id,
        itemId: line.itemId,
        quantity: line.quantity ?? 1,
        shipTo,
        acknowledged
      });
      if (gate.blocked) return gate.blocked;
      check = gate.check;
    }

    const updated = await service.upsertSalesInvoiceLine(
      ctx.asCaller.supabase,
      {
        id,
        ...line,
        updatedBy: ctx.auditUserId,
        customFields
      }
    );
    if (updated.error) {
      return ctx.error(
        "internal",
        "Failed to update sales invoice line",
        updated.error
      );
    }

    if (line.itemId && check.violations.length > 0) {
      await service.recordSalesInvoiceLineOutcome(
        ctx,
        { invoiceId: line.invoiceId, lineId: id, itemId: line.itemId },
        "acknowledged",
        check
      );
    }
    return { salesInvoiceLineId: id };
  }
});

/**
 * Delete a line of a Draft sales invoice.
 *
 * @remarks
 * Refused while the invoice is posted. A line that billed a rental period, a
 * rental charge or a contract schedule line releases it in the same
 * transaction, so the next invoice run bills it again.
 *
 * @mcp destructive
 */
export const deleteDraftSalesInvoiceLine = defineServiceFn({
  input: z.object({ invoiceId: z.string(), lineId: z.string() }),
  permission: { delete: "invoicing" },

  async run(ctx, { invoiceId, lineId }) {
    const locked = await service.unlockedSalesInvoice(
      ctx,
      invoiceId,
      "Cannot delete lines on a locked sales invoice."
    );
    if (locked) return locked;
    try {
      await deleteSalesInvoiceLineReleasingRentals(ctx.asSystem.pg, {
        companyId: ctx.company.id,
        invoiceId,
        salesInvoiceLineId: lineId,
        userId: ctx.auditUserId
      });
    } catch (err) {
      return ctx.error("internal", "Failed to delete sales invoice line", err);
    }
    return { invoiceId, lineId };
  }
});

/**
 * Delete a Draft sales invoice.
 *
 * @remarks
 * Refused once the invoice is posted. An invoice that billed rental periods,
 * rental charges or contract schedule lines releases them in the same
 * transaction, so the next invoice run bills them again.
 *
 * @mcp destructive
 */
export const deleteDraftSalesInvoice = defineServiceFn({
  input: z.object({ invoiceId: z.string() }),
  permission: { delete: "invoicing" },

  async run(ctx, { invoiceId }) {
    const locked = await service.unlockedSalesInvoice(
      ctx,
      invoiceId,
      "Only a Draft sales invoice can be deleted."
    );
    if (locked) return locked;
    try {
      await deleteSalesInvoiceReleasingRentals(ctx.asSystem.pg, {
        companyId: ctx.company.id,
        invoiceId,
        userId: ctx.auditUserId
      });
    } catch (err) {
      return ctx.error("internal", "Failed to delete sales invoice", err);
    }
    return { invoiceId };
  }
});

/**
 * Void a posted sales invoice.
 *
 * @remarks
 * Refused for an invoice that was never posted. The `post-sales-invoice`
 * server function reverses its journal, its stock and its order and shipment
 * updates; its refusal is returned as it is.
 *
 * @mcp destructive
 */
export const voidSalesInvoice = defineServiceFn({
  input: z.object({ invoiceId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { invoiceId }) {
    const invoice = await ctx.asCaller.supabase
      .from("salesInvoice")
      .select("status, postingDate")
      .eq("id", invoiceId)
      .eq("companyId", ctx.company.id)
      .maybeSingle();
    if (invoice.error) {
      return ctx.error(
        "internal",
        "Failed to void sales invoice",
        invoice.error
      );
    }
    if (!invoice.data) return ctx.error("notFound", "Sales invoice not found");
    if (!invoice.data.postingDate) {
      return ctx.error("rule", "Can only void posted invoices");
    }

    const voided = await invokePosting(
      ctx,
      "post-sales-invoice",
      {
        type: "void",
        invoiceId
      },
      service.postSalesInvoice
    );
    if (voided.error) {
      return fromServerFn(ctx, voided.error, "Failed to void sales invoice");
    }
    return { invoiceId };
  }
});

/**
 * Send a posted sales invoice again, after its send failed.
 *
 * @remarks
 * Refused for an invoice that is not posted, is voided, or was already sent.
 * Queues invoice automation with `resend`: it sends through Stripe when the
 * invoice's recurring source sends via Stripe, otherwise by email.
 *
 * @mcp
 */
export const sendSalesInvoice = defineServiceFn({
  input: z.object({ invoiceId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { invoiceId }) {
    const companyId = ctx.company.id;
    const invoice = await ctx.asCaller.supabase
      .from("salesInvoice")
      .select("id, status, postingDate, sentAt")
      .eq("id", invoiceId)
      .eq("companyId", companyId)
      .maybeSingle();
    if (invoice.error) {
      return ctx.error(
        "internal",
        "Failed to load sales invoice",
        invoice.error
      );
    }
    if (!invoice.data) return ctx.error("notFound", "Sales invoice not found");

    // Posted, as the header reads it: has a posting date and is not voided.
    if (!invoice.data.postingDate || invoice.data.status === "Voided") {
      return ctx.error("rule", "Only a posted invoice can be sent");
    }
    if (invoice.data.sentAt) {
      return ctx.error("rule", "This invoice has already been sent");
    }

    try {
      await trigger("invoice-automate", { companyId, invoiceId, resend: true });
    } catch (err) {
      return ctx.error("internal", "Failed to send invoice", err);
    }
    return { invoiceId };
  }
});
/**
 * Post a Draft sales invoice, then send it.
 *
 * @remarks
 * In order, before anything is written: the customer must have a reachable
 * contact when the company requires one; the sales-rule gate re-checks every
 * line (an error, or a warning not `acknowledged`, returns `violations` and
 * posts nothing); for `notification` Stripe, the Stripe customer the user
 * confirmed (`stripeCustomerAction`) is resolved and linked. Then the invoice
 * is claimed (Draft to Pending, refused when it is no longer a Draft) and
 * posted by the `post-sales-invoice` server function; a failed post returns
 * the invoice to Draft. After the post: the PDF is filed and, with Email, it
 * is emailed to `customerContact` (and `cc`), or with Stripe the invoice is
 * sent through the connected account. A failure after the post keeps the
 * invoice posted, stamps the send error on it and returns `warning`.
 * `locale` formats the PDF.
 *
 * @mcp
 */
export const postSalesInvoice = defineServiceFn({
  input: salesInvoicePostValidator.safeExtend({
    invoiceId: z.string(),
    acknowledged: z.boolean().default(false),
    locale: z.string().default("en-US")
  }),
  permission: { update: "invoicing" },

  async run(ctx, input) {
    const { invoiceId, notification, customerContact, locale } = input;
    const client = ctx.asCaller.supabase;
    const serviceRole = ctx.asSystem.supabase;
    const companyId = ctx.company.id;
    const userId = ctx.auditUserId;

    // Everything below reads and writes through the service role, so the
    // invoice must be this company's before anything happens.
    const refused = await refuseUnlessOwned(ctx, "salesInvoice", {
      id: invoiceId
    });
    if (refused) return refused;

    // Off by default: only for a company that asked for the policy. The read
    // fails CLOSED: a party with no id is not checked at all.
    const invoiceCustomer = await client
      .from("salesInvoice")
      .select("customerId")
      .eq("id", invoiceId)
      .eq("companyId", companyId)
      .maybeSingle();
    if (invoiceCustomer.error || !invoiceCustomer.data) {
      return ctx.error(
        "internal",
        "Failed to post sales invoice",
        invoiceCustomer.error
      );
    }
    const contactRequired = await checkPartyContactRequirement(
      client,
      companyId,
      { kind: "customer", id: invoiceCustomer.data.customerId }
    );
    if (contactRequired) return ctx.error("rule", contactRequired);

    // The revenue checkpoint, and the only gate a standalone invoice passes:
    // lines arrive from convert, the API and MCP without the per-line check.
    // Before the claim below, or a blocked post strands the invoice Pending.
    let found: SalesRuleCheck;
    try {
      found = await evaluateSalesRulesForSalesDocument({
        client: serviceRole,
        companyId,
        userId,
        documentType: "salesInvoice",
        documentId: invoiceId
      });
    } catch (err) {
      return ctx.error(
        "internal",
        `Invoice not posted — ${
          err instanceof Error ? err.message : "sales rule evaluation failed"
        }`,
        err
      );
    }
    const check = {
      violations: dedupeViolations(found.violations),
      ruleNames: found.ruleNames
    };
    if (
      check.violations.length > 0 &&
      isBlocked(check.violations, input.acknowledged)
    ) {
      await recordSalesRuleOutcome(serviceRole, {
        companyId,
        userId,
        documentType: "salesInvoice",
        documentId: invoiceId,
        outcome: "blocked",
        ...check
      });
      return check;
    }

    let stripeSend: StripeSendContext | null = null;
    if (notification === "Stripe") {
      const preflight = await service
        .preflightStripeSend(ctx, {
          invoiceId,
          customerContact,
          stripeCustomerAction: input.stripeCustomerAction,
          stripeCustomerId: input.stripeCustomerId,
          stripeContactEmail: input.stripeContactEmail
        })
        .catch(
          (err: unknown) =>
            ({
              ok: false,
              message:
                err instanceof Error
                  ? err.message
                  : "the Stripe preflight failed"
            }) as const
        );
      if (!preflight.ok) {
        return ctx.error("rule", `Invoice not posted — ${preflight.message}`);
      }
      stripeSend = preflight.context;
    }

    // Claim: only a Draft. Invoice automation's own claim IS a Pending row,
    // so re-claiming Pending here could post twice.
    const claimed = await client
      .from("salesInvoice")
      .update({ status: "Pending" })
      .eq("id", invoiceId)
      .eq("companyId", companyId)
      .eq("status", "Draft")
      .select("id")
      .maybeSingle();
    if (claimed.error) {
      return ctx.error(
        "internal",
        "Failed to update sales invoice status",
        claimed.error
      );
    }
    if (!claimed.data) {
      return ctx.error(
        "conflict",
        "This invoice is no longer a draft — it may be posting already"
      );
    }

    const posted = await invokePosting(
      ctx,
      "post-sales-invoice",
      {
        invoiceId
      },
      service.postSalesInvoice
    );
    if (posted.error) {
      // Put back OUR claim only: a failed response can still have posted, so
      // a bare reset to Draft could un-post a posted invoice.
      const released = await client
        .from("salesInvoice")
        .update({ status: "Draft" })
        .eq("id", invoiceId)
        .eq("companyId", companyId)
        .eq("status", "Pending");
      if (released.error) {
        logger.error("Failed to release a failed post", {
          companyId,
          invoiceId,
          error: released.error
        });
      }
      return fromServerFn(ctx, posted.error, "Failed to post sales invoice");
    }

    // Override evidence only once the post has committed.
    if (check.violations.length > 0) {
      await recordSalesRuleOutcome(serviceRole, {
        companyId,
        userId,
        documentType: "salesInvoice",
        documentId: invoiceId,
        outcome: "acknowledged",
        ...check
      });
    }

    // Below the rollback above: a post returned to Draft fires no workflow.
    await raiseMoment("invoicing.salesInvoicePosted", {
      outputs: { salesInvoice: { id: invoiceId }, postedBy: { id: userId } },
      companyId,
      actorId: userId
    });
    trackWorkEvent("sales_invoice_posted", {
      companyId,
      userId,
      salesInvoiceId: invoiceId
    });

    const sentVia =
      notification === "Email" || notification === "Stripe"
        ? notification
        : null;
    const warning = await service.sendPostedSalesInvoice(ctx, {
      invoiceId,
      notification: sentVia,
      customerContact,
      cc: input.cc,
      stripeSend,
      stripeDueDate: input.stripeDueDate,
      locale
    });
    return { invoiceId, sentVia, warning };
  }
});
// --- Purchase invoices --------------------------------------------------------
/**
 * Create a purchase invoice.
 *
 * @remarks
 * The invoice is created with its supplier interaction and delivery, and the
 * supplier's payment and shipping defaults. Then, optionally: one line per
 * extracted `lines` entry that has a part number or description (an item
 * when its text matches one directly, otherwise a Comment line), with the
 * whole `taxAmount` on the first line; and the file at `documentPath` (an
 * extraction upload) copied onto the supplier interaction as a document. A
 * failed line or copy does not fail the invoice.
 *
 * @mcp
 */
export const createPurchaseInvoice = defineServiceFn({
  input: purchaseInvoiceValidator.safeExtend({
    customFields: customFieldValues.optional(),
    lines: z
      .array(
        z.object({
          partNumber: z.coerce.string().nullish(),
          description: z.coerce.string().nullish(),
          quantity: z.coerce.number().nullish(),
          unitPrice: z.coerce.number().nullish()
        })
      )
      .default([]),
    taxAmount: z.number().default(0),
    documentPath: z.string().optional()
  }),
  permission: { create: "invoicing" },

  async run(
    ctx,
    { id: _id, lines, taxAmount, documentPath, customFields, ...invoice }
  ) {
    const client = ctx.asCaller.supabase;
    const companyId = ctx.company.id;
    const userId = ctx.auditUserId;

    const result = await service.insertPurchaseInvoice(client, {
      ...invoice,
      invoiceId: invoice.invoiceId || undefined,
      companyId,
      companyGroupId: ctx.company.groupId,
      createdBy: userId,
      customFields
    });
    if (result.error || !result.data) {
      return ctx.error(
        "internal",
        "Failed to insert purchase invoice",
        result.error
      );
    }
    const id = result.data.id;

    const work: Promise<unknown>[] = [];
    let taxApplied = false;
    for (const line of lines) {
      if (!line.description && !line.partNumber) continue;

      // The document's whole tax lands on the first line. The AMOUNT is what
      // the supplier charged; the rate is derived from it, held inside the
      // 0..1 fraction the validator requires. No shipping: it is 0 here.
      const lineTax = taxApplied ? 0 : taxAmount;
      taxApplied = true;
      const subtotal = taxableBase(line.unitPrice || 0, line.quantity || 1, 0);
      const taxPercent = Math.min(1, deriveRate(lineTax, subtotal));

      // Map the line when its text directly matches an item; the rest stay
      // comments for the review modal.
      const itemId = await resolveItemIdFromExtractedText(
        client,
        companyId,
        { type: "supplier", id: invoice.supplierId },
        [line.partNumber, line.description]
      );
      work.push(
        service.upsertPurchaseInvoiceLine(client, {
          invoiceId: id,
          invoiceLineType: itemId ? "Part" : "Comment",
          itemId: itemId ?? undefined,
          description: line.partNumber || line.description || "Line Item",
          quantity: line.quantity || 1,
          supplierUnitPrice: line.unitPrice || 0,
          supplierShippingCost: 0,
          supplierTaxAmount: lineTax,
          taxPercent,
          locationId: invoice.locationId,
          companyId,
          createdBy: userId,
          customFields: {}
        })
      );
    }

    if (documentPath) {
      work.push(
        (async () => {
          const created = await service.getPurchaseInvoice(client, id);
          const interactionId = created.data?.supplierInteractionId;
          if (!interactionId) return;
          const basename =
            documentPath.split("/").pop() || "Extracted_Invoice.pdf";
          const originalFilename = basename.includes("_")
            ? basename.split("_").slice(1).join("_")
            : basename;
          const newStoragePath = `${companyId}/supplier-interaction/${interactionId}/${stripSpecialCharacters(originalFilename)}`;
          const copied = await storage(client)
            .company(companyId)
            .copy(documentPath, newStoragePath);
          if (copied.error) return;
          await upsertDocument(client, {
            path: newStoragePath,
            name: originalFilename,
            size: 0,
            sourceDocument: "Purchase Invoice",
            sourceDocumentId: id,
            readGroups: [userId],
            writeGroups: [userId],
            createdBy: userId,
            companyId
          });
        })()
      );
    }
    await Promise.all(work);

    return { id, invoiceId: result.data.invoiceId };
  }
});

const purchaseInvoiceFields = [
  "invoiceSupplierId",
  "supplierId",
  "dateIssued",
  "paymentTermId",
  "currencyCode",
  "invoiceSupplierContactId",
  "invoiceSupplierLocationId",
  "locationId",
  "supplierReference",
  "exchangeRate",
  "dateDue",
  "datePaid"
] as const;

/**
 * Set one field on one or more purchase invoices.
 *
 * @remarks
 * Refused when any of the invoices is posted, except for the issue, due and
 * paid dates. A new invoice supplier brings its currency at today's rate
 * (a supplier with none keeps the invoice's) and clears the invoice contact
 * and address. A new issue date or payment term on a single invoice
 * recomputes its due date; with several invoices nothing is written. A new
 * currency brings today's exchange rate. An empty value clears the field.
 */
export const updatePurchaseInvoiceField = defineServiceFn({
  input: service.fieldUpdate(purchaseInvoiceFields),
  permission: { update: "sales" },

  async run(ctx, { ids, field, value }) {
    const locked = await service.refuseLockedInvoices(
      ctx,
      "purchaseInvoice",
      ids,
      field,
      "Cannot modify a confirmed purchase invoice."
    );
    if (locked) return locked;

    if (field === "invoiceSupplierId") {
      if (!value)
        return ctx.error("validation", "Invoice supplier is required");
      const currency = await service.partyCurrency(ctx, "supplier", value);
      if (currency instanceof Error) return currency;
      const update = await ctx.asCaller.supabase
        .from("purchaseInvoice")
        .update({
          ...purchaseInvoiceSupplierChange(value, currency),
          updatedBy: ctx.auditUserId,
          updatedAt: datetime.timestamp()
        })
        .in("id", ids)
        .eq("companyId", ctx.company.id);
      if (update.error) {
        return ctx.error(
          "internal",
          "Failed to update the invoices",
          update.error
        );
      }
      return { ids };
    }

    return service.writeInvoiceField(ctx, "purchaseInvoice", {
      ids,
      field,
      value
    });
  }
});

/**
 * Post a Draft purchase invoice.
 *
 * @remarks
 * The supplier must have a reachable contact when the company requires one.
 * The invoice is claimed (Draft or Pending to Pending; refused once posted)
 * and posted by the `post-purchase-invoice` server function, which receives
 * its lines; with `skipReceiptPost` the receipt is created but not posted,
 * for tracked items, and its id is returned as `receiptId`. When the company
 * updates purchase prices on invoice post, they are updated next. A failed
 * post or price update returns the invoice to Draft.
 *
 * @mcp
 */
export const postPurchaseInvoice = defineServiceFn({
  input: z.object({
    invoiceId: z.string(),
    skipReceiptPost: z.boolean().default(false)
  }),
  permission: { update: "invoicing" },

  async run(ctx, { invoiceId, skipReceiptPost }) {
    const client = ctx.asCaller.supabase;
    const companyId = ctx.company.id;
    const userId = ctx.auditUserId;

    const refused = await refuseUnlessOwned(ctx, "purchaseInvoice", {
      id: invoiceId
    });
    if (refused) return refused;

    // A supplier with no reachable contact cannot be created as a vendor at
    // a spend platform, so the invoice would be rejected there hours later.
    // The read fails CLOSED: a party with no id is not checked at all.
    const invoiceSupplier = await client
      .from("purchaseInvoice")
      .select("supplierId")
      .eq("id", invoiceId)
      .eq("companyId", companyId)
      .maybeSingle();
    if (invoiceSupplier.error || !invoiceSupplier.data) {
      return ctx.error(
        "internal",
        "Failed to post purchase invoice",
        invoiceSupplier.error
      );
    }
    const contactRequired = await checkPartyContactRequirement(
      client,
      companyId,
      { kind: "supplier", id: invoiceSupplier.data.supplierId }
    );
    if (contactRequired) return ctx.error("rule", contactRequired);

    const claimed = await client
      .from("purchaseInvoice")
      .update({ status: "Pending" })
      .eq("id", invoiceId)
      .eq("companyId", companyId)
      .in("status", ["Draft", "Pending"])
      .select("id");
    if (claimed.error) {
      return ctx.error(
        "internal",
        "Failed to post purchase invoice",
        claimed.error
      );
    }
    if (!claimed.data.length) {
      return ctx.error(
        "conflict",
        "This purchase invoice has already been posted"
      );
    }

    // Known gap, kept from the route: the price update runs after the post
    // has committed, so a failed one sets a posted invoice back to Draft.
    const backToDraft = async () => {
      const reverted = await client
        .from("purchaseInvoice")
        .update({ status: "Draft" })
        .eq("id", invoiceId)
        .eq("companyId", companyId);
      if (reverted.error) {
        logger.error("Failed to return a purchase invoice to Draft", {
          companyId,
          invoiceId,
          error: reverted.error
        });
      }
    };

    let receiptIds: string[] | undefined;
    try {
      const posted = await invokePosting(
        ctx,
        "post-purchase-invoice",
        {
          invoiceId,
          skipReceiptPost
        },
        service.postPurchaseInvoice
      );
      if (posted.error) {
        await backToDraft();
        return fromServerFn(
          ctx,
          posted.error,
          "Failed to post purchase invoice"
        );
      }
      receiptIds = posted.data?.receiptIds;

      const settings = await getCompanySettings(
        ctx.asSystem.supabase,
        companyId
      );
      const timing = settings.data?.purchasePriceUpdateTiming;
      if (!timing || timing === "Purchase Invoice Post") {
        const prices = await invokePosting(
          ctx,
          "update-purchased-prices",
          {
            invoiceId,
            source: "purchaseInvoice",
            updatePrices: true,
            updateLeadTimes: false
          },
          purchasingPostings.updatePurchasedPrices
        );
        if (prices.error) {
          await backToDraft();
          return ctx.error("internal", "Failed to update prices", prices.error);
        }
      }
    } catch (err) {
      await backToDraft();
      return ctx.error("internal", "Failed to post purchase invoice", err);
    }

    // Below the rollback: a post returned to Draft fires no workflow.
    await raiseMoment("invoicing.purchaseInvoicePosted", {
      outputs: { purchaseInvoice: { id: invoiceId }, postedBy: { id: userId } },
      companyId,
      actorId: userId
    });
    trackWorkEvent("purchase_invoice_posted", {
      companyId,
      userId,
      purchaseInvoiceId: invoiceId
    });

    return {
      invoiceId,
      receiptId: (skipReceiptPost && receiptIds?.[0]) || null
    };
  }
});

/**
 * Void a posted purchase invoice.
 *
 * @remarks
 * Refused for an invoice that was never posted, is already voided, or has a
 * payment applied (reverse the payment first). The `post-purchase-invoice`
 * server function reverses its journal and its receipts; its refusal is
 * returned as it is.
 *
 * @mcp destructive
 */
export const voidPurchaseInvoice = defineServiceFn({
  input: z.object({ invoiceId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { invoiceId }) {
    const invoice = await ctx.asCaller.supabase
      .from("purchaseInvoice")
      .select("status, postingDate")
      .eq("id", invoiceId)
      .eq("companyId", ctx.company.id)
      .maybeSingle();
    if (invoice.error) {
      return ctx.error(
        "internal",
        "Failed to void purchase invoice",
        invoice.error
      );
    }
    if (!invoice.data) {
      return ctx.error("notFound", "Purchase invoice not found");
    }
    const { status, postingDate } = invoice.data;
    if (!postingDate) {
      return ctx.error("rule", "Can only void posted purchase invoices");
    }
    if (status === "Voided") {
      return ctx.error("rule", "Purchase invoice is already voided");
    }
    if (status === "Paid" || status === "Partially Paid") {
      return ctx.error(
        "rule",
        "Cannot void a purchase invoice with payments applied. Reverse the payment first."
      );
    }

    const voided = await invokePosting(
      ctx,
      "post-purchase-invoice",
      {
        type: "void",
        invoiceId
      },
      service.postPurchaseInvoice
    );
    if (voided.error) {
      return fromServerFn(ctx, voided.error, "Failed to void purchase invoice");
    }
    return { invoiceId };
  }
});

/**
 * Delete a Draft purchase invoice.
 *
 * @remarks
 * Refused once the invoice is posted. An invoice that billed lease payment
 * rows returns them to Pending in the same transaction, so the next lease
 * run bills them again.
 *
 * @mcp destructive
 */
export const deleteDraftPurchaseInvoice = defineServiceFn({
  input: z.object({ invoiceId: z.string() }),
  permission: { delete: "invoicing" },

  async run(ctx, { invoiceId }) {
    const locked = await service.unlockedPurchaseInvoice(
      ctx,
      invoiceId,
      "Only a Draft purchase invoice can be deleted."
    );
    if (locked) return locked;
    try {
      await deletePurchaseInvoiceReleasingLeases(ctx.asSystem.pg, {
        companyId: ctx.company.id,
        invoiceId,
        userId: ctx.auditUserId
      });
    } catch (err) {
      return ctx.error("internal", "Failed to delete purchase invoice", err);
    }
    return { invoiceId };
  }
});

/**
 * Delete a line of a Draft purchase invoice.
 *
 * @remarks
 * Refused while the invoice is posted. A Lease line returns the payment row
 * it billed to Pending in the same transaction.
 *
 * @mcp destructive
 */
export const deleteDraftPurchaseInvoiceLine = defineServiceFn({
  input: z.object({ invoiceId: z.string(), lineId: z.string() }),
  permission: { delete: "invoicing" },

  async run(ctx, { invoiceId, lineId }) {
    const locked = await service.unlockedPurchaseInvoice(
      ctx,
      invoiceId,
      "Cannot delete lines on a confirmed purchase invoice."
    );
    if (locked) return locked;
    try {
      await deletePurchaseInvoiceLineReleasingLeases(ctx.asSystem.pg, {
        companyId: ctx.company.id,
        invoiceId,
        purchaseInvoiceLineId: lineId,
        userId: ctx.auditUserId
      });
    } catch (err) {
      return ctx.error(
        "internal",
        "Failed to delete purchase invoice line",
        err
      );
    }
    return { invoiceId, lineId };
  }
});

/**
 * Map a purchase invoice's extracted Comment lines to items.
 *
 * @remarks
 * Every line must be on the invoice and every named item the company's.
 * `map` sets the line's item; `create` first reuses the item whose part
 * number is `createName` (or the description), or creates it as a bought
 * part; `ignore` skips the line. A mapped line becomes a Part line.
 * `failed` counts the lines that could not be mapped.
 *
 * @mcp
 */
export const mapPurchaseInvoiceLines = defineServiceFn({
  input: z.object({
    invoiceId: z.string(),
    mappings: z.array(
      z.object({
        lineId: z.string(),
        action: z.enum(["map", "create", "ignore"]),
        itemId: z.string().nullish(),
        createName: z.string().nullish(),
        description: z.string().nullish()
      })
    )
  }),
  permission: { update: "invoicing" },

  async run(ctx, { invoiceId, mappings }) {
    const serviceRole = ctx.asSystem.supabase;
    const companyId = ctx.company.id;
    const userId = ctx.auditUserId;

    // Every line and item id is the caller's: prove each line is on this
    // invoice and each item this company's before any write.
    const active = mappings.filter((map) => map.action !== "ignore");
    const lineIds = [...new Set(active.map((map) => map.lineId))];
    const itemIds = [
      ...new Set(active.flatMap((map) => (map.itemId ? [map.itemId] : [])))
    ];
    if (lineIds.length > 0) {
      const lines = await serviceRole
        .from("purchaseInvoiceLine")
        .select("id")
        .eq("invoiceId", invoiceId)
        .eq("companyId", companyId)
        .in("id", lineIds);
      if (lines.error || lines.data.length !== lineIds.length) {
        logger.error("Invoice lines not found for mapping", {
          companyId,
          invoiceId,
          lineIds,
          error: lines.error
        });
        return ctx.error("notFound", "Invoice line not found");
      }
    }
    if (itemIds.length > 0) {
      const items = await serviceRole
        .from("item")
        .select("id")
        .eq("companyId", companyId)
        .in("id", itemIds);
      if (items.error || items.data.length !== itemIds.length) {
        logger.error("Items not found for invoice line mapping", {
          companyId,
          invoiceId,
          itemIds,
          error: items.error
        });
        return ctx.error("notFound", "Item not found");
      }
    }

    let failed = 0;
    for (const map of active) {
      let itemId = map.itemId;

      if (map.action === "create") {
        const name = (map.createName || map.description || "").trim();
        if (!name) continue;

        // Reuse an item with that part number rather than fail on the unique
        // constraint or create a duplicate.
        const existing = await serviceRole
          .from("item")
          .select("id")
          .eq("companyId", companyId)
          .eq("readableId", name)
          .maybeSingle();
        if (existing.data) {
          itemId = existing.data.id;
        } else {
          // The service role: the invoicing-scoped client cannot insert items.
          const created = await upsertPart(serviceRole, {
            id: name,
            name,
            revision: "0",
            description: map.description || undefined,
            replenishmentSystem: "Buy",
            defaultMethodType: "Pull from Inventory",
            itemTrackingType: "Inventory",
            unitOfMeasureCode: "EA",
            shelfLifeCalculateFromBom: false,
            companyId,
            createdBy: userId
          });
          if (created.error || !created.data?.id) {
            failed++;
            logger.error("Failed to create part for invoice line", {
              companyId,
              invoiceId,
              lineId: map.lineId,
              readableId: name,
              error: created.error
            });
          } else {
            itemId = created.data.id;
          }
        }
      }
      if (!itemId) continue;

      // Set the line's item and promote it from a Comment to a Part line.
      const mapped = await ctx.asCaller.supabase
        .from("purchaseInvoiceLine")
        .update({ itemId, invoiceLineType: "Part", updatedBy: userId })
        .eq("id", map.lineId)
        .eq("companyId", companyId);
      if (mapped.error) {
        failed++;
        logger.error("Failed to map invoice line to item", {
          companyId,
          invoiceId,
          lineId: map.lineId,
          itemId,
          error: mapped.error
        });
      }
    }

    return { failed };
  }
});

// --- Payments -----------------------------------------------------------------
/**
 * Create a Draft payment.
 *
 * @remarks
 * A deposit (`salesOrderId` / `rentalAgreementId`) must name this company's
 * and this customer's document, and a new deposit an open one; that refusal
 * is a `validation` error. The currency must be configured for the company.
 * Without a `paymentId` the next number is used. Then one application is
 * seeded per `seedInvoiceIds` invoice of the payment's party in the
 * payment's currency, for its full open balance less any early-payment
 * discount as of the payment date. When seeding fails the payment is kept
 * and `warning` says so.
 *
 * @mcp
 */
export const createPayment = defineServiceFn({
  input: paymentValidator.safeExtend({
    customFields: customFieldValues.optional(),
    seedInvoiceIds: z.array(z.string()).default([])
  }),
  permission: { create: "invoicing" },

  async run(ctx, { id: _id, seedInvoiceIds, customFields, ...payment }) {
    const client = ctx.asCaller.supabase;
    const companyId = ctx.company.id;

    // The deposit ids arrive as hidden fields: never trust them to name this
    // company's, this customer's, open document.
    const depositError = await service.checkDepositDocument(
      client,
      companyId,
      payment
    );
    if (depositError) return ctx.error("validation", depositError);

    try {
      await service.getPaymentCurrencyConfiguration(
        client,
        companyId,
        payment.currencyCode
      );
    } catch (err) {
      return ctx.error(
        "rule",
        err instanceof Error ? err.message : "Invalid currency configuration",
        err
      );
    }

    let paymentId = payment.paymentId;
    if (!paymentId) {
      const next = await getNextSequence(client, "payment", companyId);
      if (next.error || !next.data) {
        return ctx.error(
          "internal",
          "Failed to allocate payment id",
          next.error
        );
      }
      paymentId = next.data;
    }

    const inserted = await service.upsertPayment(client, {
      ...payment,
      paymentId,
      companyId,
      createdBy: ctx.auditUserId,
      customFields
    });
    if (inserted.error || !inserted.data) {
      return ctx.error("internal", "Failed to create payment", inserted.error);
    }
    const id = inserted.data.id;

    let warning: string | null = null;
    if (seedInvoiceIds.length > 0) {
      try {
        await service.seedPaymentApplications(ctx, {
          id,
          ...payment,
          seedInvoiceIds
        });
      } catch (err) {
        // A Draft with no applications is valid; they are applied by hand.
        logger.error("Failed to seed payment applications", {
          companyId,
          paymentId: id,
          error: err
        });
        warning = "Payment created, but applying it to the invoices failed";
      }
    }
    return { id, paymentId, warning };
  }
});
/**
 * Post a Draft payment.
 *
 * @remarks
 * The `post-payment` server function books the payment's journal and its
 * applications; its refusal is returned as it is.
 *
 * @mcp
 */
export const postPayment = defineServiceFn({
  input: z.object({ paymentId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { paymentId }) {
    const refused = await refuseUnlessOwned(ctx, "payment", { id: paymentId });
    if (refused) return refused;
    const posted = await invokePosting(
      ctx,
      "post-payment",
      {
        type: "post",
        paymentId
      },
      service.postPayment
    );
    if (posted.error) {
      return fromServerFn(ctx, posted.error, "Failed to post payment");
    }
    return { paymentId };
  }
});

/**
 * Void a posted payment.
 *
 * @remarks
 * The `post-payment` server function reverses the payment's journal and its
 * applications; its refusal is returned as it is.
 *
 * @mcp destructive
 */
export const voidPayment = defineServiceFn({
  input: z.object({ paymentId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { paymentId }) {
    const refused = await refuseUnlessOwned(ctx, "payment", { id: paymentId });
    if (refused) return refused;
    const voided = await invokePosting(
      ctx,
      "post-payment",
      {
        type: "void",
        paymentId
      },
      service.postPayment
    );
    if (voided.error) {
      return fromServerFn(ctx, voided.error, "Failed to void payment");
    }
    return { paymentId };
  }
});

// --- Memos and charges ---------------------------------------------------------

/**
 * Post a Draft credit or debit memo.
 *
 * @remarks
 * The `post-memo` server function books its journal; its refusal is
 * returned as it is.
 *
 * @mcp
 */
export const postMemo = defineServiceFn({
  input: z.object({ memoId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { memoId }) {
    const refused = await refuseUnlessOwned(ctx, "memo", { id: memoId });
    if (refused) return refused;
    const posted = await invokePosting(
      ctx,
      "post-memo",
      {
        type: "post",
        memoId
      },
      service.postMemo
    );
    if (posted.error) {
      return fromServerFn(ctx, posted.error, "Failed to post memo");
    }
    return { memoId };
  }
});

/**
 * Void a posted credit or debit memo.
 *
 * @remarks
 * The `post-memo` server function reverses its journal; its refusal is
 * returned as it is.
 *
 * @mcp destructive
 */
export const voidMemo = defineServiceFn({
  input: z.object({ memoId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { memoId }) {
    const refused = await refuseUnlessOwned(ctx, "memo", { id: memoId });
    if (refused) return refused;
    const voided = await invokePosting(
      ctx,
      "post-memo",
      {
        type: "void",
        memoId
      },
      service.postMemo
    );
    if (voided.error) {
      return fromServerFn(ctx, voided.error, "Failed to void memo");
    }
    return { memoId };
  }
});

/**
 * Delete a Draft credit or debit memo.
 *
 * @remarks
 * Refused once the memo is posted. A rental early-return credit returns the
 * billing periods it credits to Pending in the same transaction, so the next
 * invoice run credits them again. `party` says which list the memo was on.
 *
 * @mcp destructive
 */
export const deleteDraftMemo = defineServiceFn({
  input: z.object({ memoId: z.string() }),
  permission: { delete: "invoicing" },

  async run(ctx, { memoId }) {
    const client = ctx.asCaller.supabase;
    const companyId = ctx.company.id;
    const memo = await service.getMemo(client, memoId, companyId);
    if (memo.error) {
      return ctx.error("internal", "Failed to delete memo", memo.error);
    }
    if (!memo.data) return ctx.error("notFound", "Memo not found");
    if (isMemoLocked(memo.data.status)) {
      return ctx.error("rule", "Only a Draft memo can be deleted");
    }
    const party = memo.data.supplierId ? "supplier" : "customer";

    if (memo.data.rentalAgreementId) {
      try {
        await deleteRentalCreditMemoReleasingPeriods(ctx.asSystem.pg, {
          companyId,
          memoId,
          userId: ctx.auditUserId
        });
      } catch (err) {
        return ctx.error(
          "internal",
          err instanceof Error ? err.message : "Failed to delete memo",
          err
        );
      }
      return { memoId, party };
    }

    const removed = await service.deleteMemo(client, memoId, companyId);
    if (removed.error) {
      return ctx.error("internal", "Failed to delete memo", removed.error);
    }
    return { memoId, party };
  }
});

/**
 * Void a posted card charge.
 *
 * @remarks
 * The `post-charge` server function posts the reversing journal; its refusal
 * (an already voided charge, a Draft one) is returned as it is.
 *
 * @mcp destructive
 */
export const voidCharge = defineServiceFn({
  input: z.object({ chargeId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { chargeId }) {
    const refused = await refuseUnlessOwned(ctx, "charge", { id: chargeId });
    if (refused) return refused;
    const voided = await invokePosting(
      ctx,
      "post-charge",
      {
        type: "void",
        chargeId
      },
      accountingPostings.postCharge
    );
    if (voided.error) {
      return fromServerFn(ctx, voided.error, "Failed to void charge");
    }
    return { chargeId };
  }
});

// --- Receivables and payables ------------------------------------------------
const adjustInput = z.object({ asOfDate: z.string().optional() });

/**
 * Create a Draft journal entry for the receivables tie-out variance.
 *
 * @remarks
 * Refused before the accounting cutover, and when there is no variance as
 * of `asOfDate` (default: today). The variance is recomputed here. When the
 * subledger is above the GL, receivables is debited; otherwise it is
 * credited; the rounding account takes the other side. When the lines
 * cannot be written the Draft entry is kept and `warning` says so.
 *
 * @mcp
 */
export const adjustReceivables = defineServiceFn({
  input: adjustInput,
  permission: { create: "accounting" },
  run: (ctx, { asOfDate }) => service.adjustTieOut(ctx, "receivables", asOfDate)
});

/**
 * Create a Draft journal entry for the payables tie-out variance.
 *
 * @remarks
 * Refused before the accounting cutover, and when there is no variance as
 * of `asOfDate` (default: today). The variance is recomputed here. When the
 * subledger is above the GL, payables is credited; otherwise it is debited;
 * the rounding account takes the other side. When the lines cannot be
 * written the Draft entry is kept and `warning` says so.
 *
 * @mcp
 */
export const adjustPayables = defineServiceFn({
  input: adjustInput,
  permission: { create: "accounting" },
  run: (ctx, { asOfDate }) => service.adjustTieOut(ctx, "payables", asOfDate)
});

// --- Reimbursements -------------------------------------------------------------
const REIMBURSEMENT_UNBALANCED_MESSAGE =
  "The coding lines must sum to the reimbursement amount before posting";
const reimbursementInput = reimbursementUpdateValidator.safeExtend({
  customFields: customFieldValues.optional(),
  lines: reimbursementLinesValidator
});

/**
 * Change a Draft reimbursement and replace its coding lines.
 *
 * @remarks
 * Refused once the reimbursement is posted. The header is updated, then the
 * lines are replaced as sent (each with its dimension pairs). Currency and
 * exchange rate are the source transaction's facts and are not changed.
 *
 * @mcp
 */
export const saveReimbursement = defineServiceFn({
  input: reimbursementInput,
  permission: { update: "invoicing" },

  async run(ctx, { lines, customFields, ...header }) {
    const existing = await service.loadReimbursement(ctx, header.id);
    if (existing instanceof Error) return existing;
    // A readable refusal beats the raw 55000 the draft guard trigger raises.
    if (existing.status !== "Draft") {
      return ctx.error("rule", "A posted reimbursement cannot be edited");
    }

    const updated = await service.updateReimbursement(ctx.asCaller.supabase, {
      ...header,
      companyId: ctx.company.id,
      updatedBy: ctx.auditUserId,
      customFields
    });
    if (updated.error) {
      return ctx.error(
        "internal",
        "Failed to update reimbursement",
        updated.error
      );
    }

    try {
      await service.upsertReimbursementLines(ctx.asSystem.pg, {
        reimbursementId: header.id,
        companyId: ctx.company.id,
        createdBy: ctx.auditUserId,
        lines
      });
    } catch (err) {
      return ctx.error(
        "internal",
        err instanceof Error && err.message
          ? err.message
          : "Failed to save coding lines",
        err
      );
    }
    return { reimbursementId: header.id };
  }
});

/**
 * Change a Draft reimbursement, replace its coding lines, then post it.
 *
 * @remarks
 * Before anything is written, the lines must sum to the amount. Then as
 * `saveReimbursement`, then as `postReimbursement`. When the post fails
 * the changes are kept.
 *
 * @mcp
 */
export const saveAndPostReimbursement = defineServiceFn({
  input: reimbursementInput,
  permission: { update: "invoicing" },

  async run(ctx, input) {
    if (
      !service.linesBalanceHeader(
        input.amount,
        input.lines.map((line) => line.amount)
      )
    ) {
      return ctx.error("rule", REIMBURSEMENT_UNBALANCED_MESSAGE);
    }
    const updated = await saveReimbursement(ctx, input);
    if (updated.error) return updated.error;
    const posted = await postReimbursement(ctx, { reimbursementId: input.id });
    if (posted.error) return posted.error;
    return { reimbursementId: input.id };
  }
});

/**
 * Post a Draft reimbursement.
 *
 * @remarks
 * Refused unless the reimbursement is a Draft whose coding lines sum to its
 * amount. The `post-reimbursement` server function books its journal; its
 * refusal is returned as it is.
 *
 * @mcp
 */
export const postReimbursement = defineServiceFn({
  input: z.object({ reimbursementId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { reimbursementId }) {
    const reimbursement = await service.loadReimbursement(ctx, reimbursementId);
    if (reimbursement instanceof Error) return reimbursement;
    if (reimbursement.status !== "Draft") {
      return ctx.error("rule", "Only a Draft reimbursement can be posted");
    }
    // Checked here, with a readable message, before the server function.
    const lines = reimbursement.reimbursementLine ?? [];
    if (
      !service.linesBalanceHeader(
        Number(reimbursement.amount),
        lines.map((line) => Number(line.amount))
      )
    ) {
      return ctx.error("rule", REIMBURSEMENT_UNBALANCED_MESSAGE);
    }

    const posted = await invokePosting(
      ctx,
      "post-reimbursement",
      {
        type: "post",
        reimbursementId
      },
      accountingPostings.postReimbursement
    );
    if (posted.error) {
      return fromServerFn(ctx, posted.error, "Failed to post reimbursement");
    }
    return { reimbursementId };
  }
});

/**
 * Void a posted reimbursement.
 *
 * @remarks
 * The `post-reimbursement` server function reverses whatever was posted; its
 * refusal is returned as it is.
 *
 * @mcp destructive
 */
export const voidReimbursement = defineServiceFn({
  input: z.object({ reimbursementId: z.string() }),
  permission: { update: "invoicing" },

  async run(ctx, { reimbursementId }) {
    const refused = await refuseUnlessOwned(ctx, "reimbursement", {
      id: reimbursementId
    });
    if (refused) return refused;
    const voided = await invokePosting(
      ctx,
      "post-reimbursement",
      {
        type: "void",
        reimbursementId
      },
      accountingPostings.postReimbursement
    );
    if (voided.error) {
      return fromServerFn(ctx, voided.error, "Failed to void reimbursement");
    }
    return { reimbursementId };
  }
});

/**
 * Pay a posted reimbursement to the employee.
 *
 * @remarks
 * Refused unless the reimbursement is Posted, has a balance due, and
 * `amount` (in its currency) is at most that balance, read again here. The
 * currency must be configured for the company. Creates a disbursement to
 * the employee at the reimbursement's own exchange rate, applies it to the
 * reimbursement, and posts it with `post-payment`. When the application or
 * the post fails, the Draft payment is kept and `warning` says so.
 *
 * @mcp
 */
export const payReimbursement = defineServiceFn({
  input: reimbursementPaymentValidator.safeExtend({
    reimbursementId: z.string()
  }),
  permission: { create: "invoicing" },

  async run(ctx, { reimbursementId, amount, paymentDate, bankAccount }) {
    const client = ctx.asCaller.supabase;
    const companyId = ctx.company.id;

    const reimbursement = await service.loadReimbursement(ctx, reimbursementId);
    if (reimbursement instanceof Error) return reimbursement;
    if (reimbursement.status !== "Posted") {
      return ctx.error("rule", "Only a posted reimbursement can be paid");
    }

    // The modal's default came from a loader that may be minutes old, and
    // a second payout must not overdraw the payable.
    const open = await service.getOpenReimbursementsForEmployee(
      client,
      companyId,
      reimbursement.employeeId,
      reimbursement.currencyCode
    );
    if (open.error) {
      return ctx.error(
        "internal",
        "Failed to load the balance due",
        open.error
      );
    }
    const balance = (open.data ?? []).find((r) => r.id === reimbursementId);
    if (!balance) {
      return ctx.error("rule", "This reimbursement is fully paid");
    }
    if (amount > balance.remainingDocument) {
      return ctx.error(
        "rule",
        "The amount exceeds the reimbursement's balance due"
      );
    }

    try {
      await service.getPaymentCurrencyConfiguration(
        client,
        companyId,
        reimbursement.currencyCode
      );
    } catch (err) {
      return ctx.error(
        "rule",
        err instanceof Error ? err.message : "Invalid currency configuration",
        err
      );
    }

    const next = await getNextSequence(client, "payment", companyId);
    if (next.error || !next.data) {
      return ctx.error("internal", "Failed to allocate payment id", next.error);
    }

    // Paid at the reimbursement's own rate: no revaluation nobody asked for.
    const exchangeRate = Number(reimbursement.exchangeRate);
    const payment = await service.upsertPayment(client, {
      paymentId: next.data,
      paymentType: "Disbursement",
      employeeId: reimbursement.employeeId,
      paymentDate,
      currencyCode: reimbursement.currencyCode,
      exchangeRate,
      totalAmount: amount,
      bankAccount,
      companyId,
      createdBy: ctx.auditUserId
    });
    if (payment.error || !payment.data) {
      return ctx.error(
        "internal",
        "Failed to create the payment",
        payment.error
      );
    }
    const paymentId = payment.data.id;

    try {
      // The employee arm here is the authority on party, currency, Posted
      // status and the balance ceiling.
      await service.replaceInvoiceSettlements(ctx.asSystem.pg, {
        paymentId,
        companyId,
        createdBy: ctx.auditUserId,
        applications: [
          {
            targetReimbursementId: reimbursementId,
            sourceAmount: amount,
            appliedAmount: toBaseAmount(amount, exchangeRate),
            discountAmount: 0,
            writeOffAmount: 0,
            targetExchangeRate: exchangeRate,
            sourceExchangeRate: exchangeRate,
            appliedDate: paymentDate
          }
        ]
      });
    } catch (err) {
      logger.error("Failed to apply a reimbursement payout", {
        companyId,
        reimbursementId,
        paymentId,
        error: err
      });
      return {
        paymentId,
        warning: "Payment created, but applying it to the reimbursement failed"
      };
    }

    const posted = await invokePosting(
      ctx,
      "post-payment",
      {
        type: "post",
        paymentId
      },
      service.postPayment
    );
    if (posted.error) {
      logger.error("Failed to post a reimbursement payout", {
        companyId,
        reimbursementId,
        paymentId,
        error: posted.error
      });
      return {
        paymentId,
        warning: posted.error.message || "Failed to post the payment"
      };
    }
    return { paymentId, warning: null };
  }
});
/**
 * Create purchase invoice from purchase order
 *
 * @mcp
 */
export const createPurchaseInvoiceFromPurchaseOrder = defineServiceFn({
  input: z.looseObject({ purchaseOrderId: z.string() }),
  permission: { create: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.createPurchaseInvoiceFromPurchaseOrder(
        ctx.asCaller.supabase,
        ctx.asSystem.pg,
        input.purchaseOrderId as never,
        ctx.company.id,
        ctx.auditUserId
      )
    );
  }
});

/**
 * Create sales invoice from sales order
 *
 * @mcp
 */
export const createSalesInvoiceFromSalesOrder = defineServiceFn({
  input: z.looseObject({ salesOrderId: z.string() }),
  permission: { create: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.createSalesInvoiceFromSalesOrder(
        ctx.asCaller.supabase,
        ctx.asSystem.pg,
        input.salesOrderId as never,
        ctx.company.id,
        ctx.auditUserId
      )
    );
  }
});

/**
 * Create sales invoice from shipment
 *
 * @mcp
 */
export const createSalesInvoiceFromShipment = defineServiceFn({
  input: z.looseObject({ shipmentId: z.string() }),
  permission: { create: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.createSalesInvoiceFromShipment(
        ctx.asCaller.supabase,
        ctx.asSystem.pg,
        input.shipmentId as never,
        ctx.company.id,
        ctx.auditUserId
      )
    );
  }
});

/**
 * Get purchase invoice
 *
 * @mcp read
 */
export const getPurchaseInvoice = defineServiceFn({
  input: z.looseObject({ purchaseInvoiceId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getPurchaseInvoice(
        ctx.asCaller.supabase,
        input.purchaseInvoiceId as never
      )
    );
  }
});

/**
 * Get purchase invoices
 *
 * @mcp read
 */
export const getPurchaseInvoices = defineServiceFn({
  input: z.looseObject({
    limit: z
      .number()
      .int()
      .describe("Rows per page. Left out, the read is not paged.")
      .optional(),
    offset: z.number().int().default(0),
    search: z.string().nullable().optional(),
    supplierId: z.string().nullable().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return paged(
      ctx,
      await service.getPurchaseInvoices(
        ctx.asCaller.supabase,
        ctx.company.id,
        payload(ctx, input).build() as never
      )
    );
  }
});

/**
 * Get purchase invoice delivery
 *
 * @mcp read
 */
export const getPurchaseInvoiceDelivery = defineServiceFn({
  input: z.looseObject({ purchaseInvoiceId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getPurchaseInvoiceDelivery(
        ctx.asCaller.supabase,
        input.purchaseInvoiceId as never
      )
    );
  }
});

/**
 * Get purchase invoice lines
 *
 * @mcp read
 */
export const getPurchaseInvoiceLines = defineServiceFn({
  input: z.looseObject({ purchaseInvoiceId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getPurchaseInvoiceLines(
        ctx.asCaller.supabase,
        input.purchaseInvoiceId as never
      )
    );
  }
});

/**
 * Get purchase invoice line
 *
 * @mcp read
 */
export const getPurchaseInvoiceLine = defineServiceFn({
  input: z.looseObject({ purchaseInvoiceLineId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getPurchaseInvoiceLine(
        ctx.asCaller.supabase,
        input.purchaseInvoiceLineId as never
      )
    );
  }
});

/**
 * Get sales invoice
 *
 * @mcp read
 */
export const getSalesInvoice = defineServiceFn({
  input: z.looseObject({ salesInvoiceId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getSalesInvoice(
        ctx.asCaller.supabase,
        input.salesInvoiceId as never
      )
    );
  }
});

/**
 * Get sales invoices
 *
 * @mcp read
 */
export const getSalesInvoices = defineServiceFn({
  input: z.looseObject({
    limit: z
      .number()
      .int()
      .describe("Rows per page. Left out, the read is not paged.")
      .optional(),
    offset: z.number().int().default(0),
    search: z.string().nullable().optional(),
    customerId: z.string().nullable().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return paged(
      ctx,
      await service.getSalesInvoices(
        ctx.asCaller.supabase,
        ctx.company.id,
        payload(ctx, input).build() as never
      )
    );
  }
});

/**
 * Get sales invoice shipment
 *
 * @mcp read
 */
export const getSalesInvoiceShipment = defineServiceFn({
  input: z.looseObject({ salesInvoiceId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getSalesInvoiceShipment(
        ctx.asCaller.supabase,
        input.salesInvoiceId as never
      )
    );
  }
});

/**
 * Get sales invoice lines
 *
 * @mcp read
 */
export const getSalesInvoiceLines = defineServiceFn({
  input: z.looseObject({ salesInvoiceId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getSalesInvoiceLines(
        ctx.asCaller.supabase,
        input.salesInvoiceId as never
      )
    );
  }
});

/**
 * Get sales invoice line
 *
 * @mcp read
 */
export const getSalesInvoiceLine = defineServiceFn({
  input: z.looseObject({ salesInvoiceLineId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getSalesInvoiceLine(
        ctx.asCaller.supabase,
        input.salesInvoiceLineId as never
      )
    );
  }
});

/**
 * Update purchase invoice exchange rate
 *
 * @mcp
 */
export const updatePurchaseInvoiceExchangeRate = defineServiceFn({
  input: z.looseObject({ id: z.string(), exchangeRate: z.number() }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.updatePurchaseInvoiceExchangeRate(
        ctx.asCaller.supabase,
        payload(ctx, input).forUpdate() as never
      )
    );
  }
});

/**
 * Update sales invoice exchange rate
 *
 * @mcp
 */
export const updateSalesInvoiceExchangeRate = defineServiceFn({
  input: z.looseObject({ id: z.string(), exchangeRate: z.number() }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.updateSalesInvoiceExchangeRate(
        ctx.asCaller.supabase,
        payload(ctx, input).forUpdate() as never
      )
    );
  }
});

/**
 * Update purchase invoice
 *
 * @mcp
 */
export const updatePurchaseInvoice = defineServiceFn({
  input: z.looseObject({
    id: z.string(),
    invoiceId: z.string().optional(),
    supplierId: z.string().optional(),
    supplierReference: z.string().nullable().optional(),
    paymentTermId: z.string().nullable().optional(),
    currencyCode: z.string().optional(),
    locationId: z.string().optional(),
    invoiceSupplierId: z.string().nullable().optional(),
    invoiceSupplierContactId: z.string().nullable().optional(),
    invoiceSupplierLocationId: z.string().nullable().optional(),
    dateIssued: z.string().nullable().optional(),
    dateDue: z.string().nullable().optional(),
    exchangeRate: z.number().optional(),
    exchangeRateUpdatedAt: z.string().optional(),
    customFields: z.unknown().optional()
  }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.updatePurchaseInvoice(
        ctx.asCaller.supabase,
        payload(ctx, input).forUpdate() as never
      )
    );
  }
});

/**
 * Updates an invoice's delivery
 *
 * @mcp
 */
export const upsertPurchaseInvoiceDelivery = defineServiceFn({
  input: z.looseObject({
    id: z.string(),
    locationId: z.string().optional(),
    shippingMethodId: z.string().optional(),
    shippingTermId: z.string().optional(),
    supplierShippingCost: z.number().optional(),
    incoterm: z
      .enum([
        "EXW",
        "FCA",
        "FAS",
        "FOB",
        "CPT",
        "CIP",
        "CFR",
        "CIF",
        "DAP",
        "DPU",
        "DDP"
      ])
      .optional(),
    incotermLocation: z.string().optional(),
    customFields: z.unknown().optional()
  }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.upsertPurchaseInvoiceDelivery(
        ctx.asCaller.supabase,
        payload(ctx, input).forUpdate() as never
      )
    );
  }
});

/**
 * Create a purchase invoice line
 *
 * @remarks
 * Upsert purchase invoice line
 *
 * @mcp
 */
export const createPurchaseInvoiceLine = defineServiceFn({
  input: z.looseObject({
    invoiceId: z.string().min(1),
    invoiceLineType: z.enum([
      "Part",
      "Material",
      "Tool",
      "Consumable",
      "Service",
      "Fixture",
      "G/L Account",
      "Fixed Asset",
      "Lease",
      "Comment"
    ]),
    purchaseOrderId: z.string().optional(),
    purchaseOrderLineId: z.string().optional(),
    itemId: z.string().optional(),
    accountId: z.string().optional(),
    costCenterId: z.string().optional(),
    assetId: z.string().optional(),
    leaseId: z.string().optional(),
    leasePaymentId: z.string().optional(),
    description: z.string().optional(),
    quantity: z.number().optional(),
    purchaseUnitOfMeasureCode: z.string().optional(),
    inventoryUnitOfMeasureCode: z.string().optional(),
    conversionFactor: z.number().optional(),
    supplierUnitPrice: z.number().optional(),
    supplierShippingCost: z
      .number()
      .default(0)
      .describe(
        "Applied when creating; on update a field left out keeps its value."
      ),
    supplierTaxAmount: z
      .number()
      .default(0)
      .describe(
        "Applied when creating; on update a field left out keeps its value."
      ),
    taxPercent: z
      .number()
      .min(0)
      .max(1)
      .default(0)
      .describe(
        "Applied when creating; on update a field left out keeps its value."
      ),
    requiredDate: z.string().optional(),
    locationId: z.string().optional(),
    storageUnitId: z.string().optional(),
    exchangeRate: z.number().optional(),
    customFields: z.unknown().optional(),
    id: z
      .string()
      .describe("Send to update that record; omit to create a new one.")
      .optional()
  }),
  permission: { create: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.upsertPurchaseInvoiceLine(
        ctx.asCaller.supabase,
        payload(ctx, input).forCreate() as never
      )
    );
  }
});

/**
 * Update a purchase invoice line
 *
 * @remarks
 * Upsert purchase invoice line
 *
 * @mcp
 */
export const updatePurchaseInvoiceLine = defineServiceFn({
  input: z
    .looseObject({
      invoiceId: z.string().min(1),
      invoiceLineType: z.enum([
        "Part",
        "Material",
        "Tool",
        "Consumable",
        "Service",
        "Fixture",
        "G/L Account",
        "Fixed Asset",
        "Lease",
        "Comment"
      ]),
      purchaseOrderId: z.string().optional(),
      purchaseOrderLineId: z.string().optional(),
      itemId: z.string().optional(),
      accountId: z.string().optional(),
      costCenterId: z.string().optional(),
      assetId: z.string().optional(),
      leaseId: z.string().optional(),
      leasePaymentId: z.string().optional(),
      description: z.string().optional(),
      quantity: z.number().optional(),
      purchaseUnitOfMeasureCode: z.string().optional(),
      inventoryUnitOfMeasureCode: z.string().optional(),
      conversionFactor: z.number().optional(),
      supplierUnitPrice: z.number().optional(),
      supplierShippingCost: z
        .number()
        .describe(
          "Applied when creating; on update a field left out keeps its value."
        )
        .optional(),
      supplierTaxAmount: z
        .number()
        .describe(
          "Applied when creating; on update a field left out keeps its value."
        )
        .optional(),
      taxPercent: z
        .number()
        .min(0)
        .max(1)
        .describe(
          "Applied when creating; on update a field left out keeps its value."
        )
        .optional(),
      requiredDate: z.string().optional(),
      locationId: z.string().optional(),
      storageUnitId: z.string().optional(),
      exchangeRate: z.number().optional(),
      customFields: z.unknown().optional(),
      id: z
        .string()
        .describe("Send to update that record; omit to create a new one.")
        .optional()
    })
    .required({ id: true }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.upsertPurchaseInvoiceLine(
        ctx.asCaller.supabase,
        payload(ctx, input).forUpdate() as never
      )
    );
  }
});

/**
 * Update purchase invoice line order
 *
 * @mcp
 */
export const updatePurchaseInvoiceLineOrder = defineServiceFn({
  input: z.looseObject({
    invoiceId: z.string(),
    updates: z.array(z.looseObject({ id: z.string(), sortOrder: z.number() }))
  }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return await service.updatePurchaseInvoiceLineOrder(
      ctx.asSystem.pg,
      ctx.company.id,
      ctx.auditUserId,
      input.invoiceId as never,
      payload(ctx, input.updates).forUpdate() as never
    );
  }
});

/**
 * Insert sales invoice
 *
 * @mcp destructive
 */
export const insertSalesInvoice = defineServiceFn({
  input: z.looseObject({
    customerId: z.string(),
    invoiceId: z.string().optional(),
    customerReference: z.string().optional(),
    paymentTermId: z.string().optional(),
    currencyCode: z.string().optional(),
    locationId: z.string().optional(),
    invoiceCustomerId: z.string().optional(),
    invoiceCustomerContactId: z.string().optional(),
    invoiceCustomerLocationId: z.string().optional(),
    dateIssued: z.string().optional(),
    dateDue: z.string().optional(),
    exchangeRate: z.number().optional(),
    exchangeRateUpdatedAt: z.string().optional(),
    customFields: z.unknown().optional()
  }),
  permission: { create: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.insertSalesInvoice(
        ctx.asCaller.supabase,
        payload(ctx, input).withGroup().forUpsert() as never
      )
    );
  }
});

/**
 * Updates an invoice's shipment
 *
 * @mcp
 */
export const upsertSalesInvoiceShipment = defineServiceFn({
  input: z.looseObject({
    id: z.string(),
    locationId: z.string().optional(),
    customerLocationId: z.string().optional(),
    shippingMethodId: z.string().optional(),
    shippingTermId: z.string().optional(),
    shippingCost: z.number().optional(),
    incoterm: z
      .enum([
        "EXW",
        "FCA",
        "FAS",
        "FOB",
        "CPT",
        "CIP",
        "CFR",
        "CIF",
        "DAP",
        "DPU",
        "DDP"
      ])
      .optional(),
    incotermLocation: z.string().optional(),
    customFields: z.unknown().optional()
  }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.upsertSalesInvoiceShipment(
        ctx.asCaller.supabase,
        payload(ctx, input).forUpdate() as never
      )
    );
  }
});

/**
 * Update sales invoice line order
 *
 * @mcp
 */
export const updateSalesInvoiceLineOrder = defineServiceFn({
  input: z.looseObject({
    invoiceId: z.string(),
    updates: z.array(z.looseObject({ id: z.string(), sortOrder: z.number() }))
  }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return await service.updateSalesInvoiceLineOrder(
      ctx.asSystem.pg,
      ctx.company.id,
      ctx.auditUserId,
      input.invoiceId as never,
      payload(ctx, input.updates).forUpdate() as never
    );
  }
});

/**
 * Get payment
 *
 * @mcp read
 */
export const getPayment = defineServiceFn({
  input: z.looseObject({ id: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getPayment(
        ctx.asCaller.supabase,
        input.id as never,
        ctx.company.id
      )
    );
  }
});

/**
 * Get payments
 *
 * @mcp read
 */
export const getPayments = defineServiceFn({
  input: z.looseObject({
    limit: z
      .number()
      .int()
      .describe("Rows per page. Left out, the read is not paged.")
      .optional(),
    offset: z.number().int().default(0),
    search: z.string().nullable().optional(),
    paymentType: z.enum(["Receipt", "Disbursement"]).nullable().optional(),
    status: z.enum(["Draft", "Posted", "Voided"]).nullable().optional(),
    customerId: z.string().nullable().optional(),
    supplierId: z.string().nullable().optional(),
    counterpartyIds: z.array(z.string()).nullable().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return paged(
      ctx,
      await service.getPayments(
        ctx.asCaller.supabase,
        ctx.company.id,
        payload(ctx, input).build() as never
      )
    );
  }
});

/**
 * Get charge
 *
 * @mcp read
 */
export const getCharge = defineServiceFn({
  input: z.looseObject({ id: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getCharge(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.id as never
      )
    );
  }
});

/**
 * Get charges
 *
 * @mcp read
 */
export const getCharges = defineServiceFn({
  input: z.looseObject({
    limit: z
      .number()
      .int()
      .describe("Rows per page. Left out, the read is not paged.")
      .optional(),
    offset: z.number().int().default(0),
    search: z.string().nullable().optional(),
    type: z
      .enum(["Charge", "Credit", "Payment", "Cashback", "Repayment"])
      .nullable()
      .optional(),
    status: z.enum(["Draft", "Posted", "Voided"]).nullable().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return paged(
      ctx,
      await service.getCharges(
        ctx.asCaller.supabase,
        ctx.company.id,
        payload(ctx, input).build() as never
      )
    );
  }
});

/**
 * Get reimbursement
 *
 * @mcp read
 */
export const getReimbursement = defineServiceFn({
  input: z.looseObject({ id: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getReimbursement(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.id as never
      )
    );
  }
});

/**
 * Get reimbursements
 *
 * @mcp read
 */
export const getReimbursements = defineServiceFn({
  input: z.looseObject({
    limit: z
      .number()
      .int()
      .describe("Rows per page. Left out, the read is not paged.")
      .optional(),
    offset: z.number().int().default(0),
    search: z.string().nullable().optional(),
    status: z.enum(["Draft", "Posted", "Voided"]).nullable().optional(),
    employeeId: z.string().nullable().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return paged(
      ctx,
      await service.getReimbursements(
        ctx.asCaller.supabase,
        ctx.company.id,
        payload(ctx, input).build() as never
      )
    );
  }
});

/**
 * The payments that settle a reimbursement, for its Documents panel
 *
 * @mcp read
 */
export const getReimbursementRelatedItems = defineServiceFn({
  input: z.looseObject({ reimbursementId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return await service.getReimbursementRelatedItems(
      ctx.asCaller.supabase,
      ctx.company.id,
      input.reimbursementId as never
    );
  }
});

/**
 * Get invoice settlements
 *
 * @mcp read
 */
export const getInvoiceSettlements = defineServiceFn({
  input: z.looseObject({ paymentId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getInvoiceSettlements(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.paymentId as never
      )
    );
  }
});

/**
 * Get invoice settlements for invoice
 *
 * @mcp read
 */
export const getInvoiceSettlementsForInvoice = defineServiceFn({
  input: z.looseObject({
    side: z.enum(["sales", "purchase"]),
    invoiceId: z.string()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getInvoiceSettlementsForInvoice(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.side as never,
        input.invoiceId as never
      )
    );
  }
});

/**
 * Get memo applications
 *
 * @mcp read
 */
export const getMemoApplications = defineServiceFn({
  input: z.looseObject({ memoId: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getMemoApplications(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.memoId as never
      )
    );
  }
});

/**
 * Get open sales invoices for customer
 *
 * @mcp read
 */
export const getOpenSalesInvoicesForCustomer = defineServiceFn({
  input: z.looseObject({
    customerId: z.string(),
    currencyCode: z.string().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getOpenSalesInvoicesForCustomer(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.customerId as never,
        input.currencyCode as never
      )
    );
  }
});

/**
 * Get open purchase invoices for supplier
 *
 * @mcp read
 */
export const getOpenPurchaseInvoicesForSupplier = defineServiceFn({
  input: z.looseObject({
    supplierId: z.string(),
    currencyCode: z.string().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getOpenPurchaseInvoicesForSupplier(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.supplierId as never,
        input.currencyCode as never
      )
    );
  }
});

/**
 * Posted reimbursements an employee is still owed money on.
 *
 * @remarks
 * The apply table's target list when a payment's payee is an employee, and the
 * balance the Pay expense modal defaults to. A read only: posting a payment
 * locks and checks the reimbursements again.
 *
 * @mcp read
 */
export const getOpenReimbursementsForEmployee = defineServiceFn({
  input: z.looseObject({
    employeeId: z.string(),
    currencyCode: z.string().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getOpenReimbursementsForEmployee(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.employeeId as never,
        input.currencyCode as never
      )
    );
  }
});

/**
 * Get payment currency configuration
 *
 * @mcp read
 */
export const getPaymentCurrencyConfiguration = defineServiceFn({
  input: z.looseObject({ currencyCode: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return await service.getPaymentCurrencyConfiguration(
      ctx.asCaller.supabase,
      ctx.company.id,
      input.currencyCode as never
    );
  }
});

/**
 * Get available on account credit sources
 *
 * @mcp read
 */
export const getAvailableOnAccountCreditSources = defineServiceFn({
  input: z.looseObject({
    party: z.union([
      z.looseObject({
        paymentType: z.literal("Receipt"),
        customerId: z.string()
      }),
      z.looseObject({
        paymentType: z.literal("Disbursement"),
        supplierId: z.string()
      })
    ]),
    currencyCode: z.string()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getAvailableOnAccountCreditSources(
        ctx.asCaller.supabase,
        ctx.company.id,
        payload(ctx, input.party).build() as never,
        input.currencyCode as never
      )
    );
  }
});

/**
 * Update a payment
 *
 * @remarks
 * Upsert payment
 *
 * @mcp
 */
export const updatePayment = defineServiceFn({
  input: z
    .looseObject({
      paymentType: z.enum(["Receipt", "Disbursement"]),
      customerId: z.string().optional(),
      supplierId: z.string().optional(),
      employeeId: z.string().optional(),
      paymentDate: z.string().min(1),
      currencyCode: z.string().min(1),
      exchangeRate: z
        .number()
        .gt(0)
        .describe(
          "Applied when creating; on update a field left out keeps its value."
        )
        .optional(),
      totalAmount: z.number().min(0),
      bankAccount: z.string().min(1),
      reference: z.string().optional(),
      memo: z.string().optional(),
      salesOrderId: z.string().optional(),
      rentalAgreementId: z.string().optional(),
      paymentId: z.string().optional(),
      customFields: z.unknown().optional(),
      id: z
        .string()
        .describe("Send to update that record; omit to create a new one.")
        .optional()
    })
    .required({ id: true }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.upsertPayment(
        ctx.asCaller.supabase,
        payload(ctx, input).forUpdate() as never
      )
    );
  }
});

/**
 * Delete payment
 *
 * @mcp destructive
 */
export const deletePayment = defineServiceFn({
  input: z.looseObject({ id: z.string() }),
  permission: { delete: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.deletePayment(
        ctx.asCaller.supabase,
        input.id as never,
        ctx.company.id
      )
    );
  }
});

/**
 * Replace invoice settlements
 *
 * @mcp destructive
 */
export const replaceInvoiceSettlements = defineServiceFn({
  input: z.looseObject({
    paymentId: z.string(),
    applications: z.array(
      z.looseObject({
        memoId: z.string().optional(),
        targetSalesInvoiceId: z.string().optional(),
        targetPurchaseInvoiceId: z.string().optional(),
        targetMemoId: z.string().optional(),
        targetReimbursementId: z.string().optional(),
        sourceAmount: z.number().min(0).optional(),
        appliedAmount: z.number().min(0).default(0),
        discountAmount: z.number().min(0).default(0),
        writeOffAmount: z.number().min(0).default(0),
        targetExchangeRate: z.number().gt(0),
        sourceExchangeRate: z.number().gt(0),
        appliedDate: z.string().min(1)
      })
    )
  }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return await service.replaceInvoiceSettlements(
      ctx.asSystem.pg,
      payload(ctx, input).forCreate() as never
    );
  }
});

/**
 * Get memo
 *
 * @mcp read
 */
export const getMemo = defineServiceFn({
  input: z.looseObject({ id: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getMemo(
        ctx.asCaller.supabase,
        input.id as never,
        ctx.company.id
      )
    );
  }
});

/**
 * Get memos
 *
 * @mcp read
 */
export const getMemos = defineServiceFn({
  input: z.looseObject({
    limit: z
      .number()
      .int()
      .describe("Rows per page. Left out, the read is not paged.")
      .optional(),
    offset: z.number().int().default(0),
    search: z.string().nullable().optional(),
    direction: z.enum(["Credit", "Debit"]).nullable().optional(),
    status: z.enum(["Draft", "Posted", "Voided"]).nullable().optional(),
    counterpartyIds: z.array(z.string()).nullable().optional(),
    party: z.enum(["customer", "supplier"]).nullable().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return paged(
      ctx,
      await service.getMemos(
        ctx.asCaller.supabase,
        ctx.company.id,
        payload(ctx, input).build() as never
      )
    );
  }
});

/**
 * Create a memo
 *
 * @remarks
 * Upsert memo
 *
 * @mcp
 */
export const createMemo = defineServiceFn({
  input: z.looseObject({
    direction: z.enum(["Credit", "Debit"]),
    customerId: z.string().optional(),
    supplierId: z.string().optional(),
    memoDate: z.string().min(1),
    currencyCode: z.string().min(1),
    exchangeRate: z
      .number()
      .gt(0)
      .default(1)
      .describe(
        "Applied when creating; on update a field left out keeps its value."
      ),
    amount: z.number().gt(0),
    reference: z.string().optional(),
    notes: z.string().optional(),
    memoId: z.string().optional(),
    customFields: z.unknown().optional(),
    id: z
      .string()
      .describe("Send to update that record; omit to create a new one.")
      .optional()
  }),
  permission: { create: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.upsertMemo(
        ctx.asCaller.supabase,
        payload(ctx, input).forCreate() as never
      )
    );
  }
});

/**
 * Update a memo
 *
 * @remarks
 * Upsert memo
 *
 * @mcp
 */
export const updateMemo = defineServiceFn({
  input: z
    .looseObject({
      direction: z.enum(["Credit", "Debit"]),
      customerId: z.string().optional(),
      supplierId: z.string().optional(),
      memoDate: z.string().min(1),
      currencyCode: z.string().min(1),
      exchangeRate: z
        .number()
        .gt(0)
        .describe(
          "Applied when creating; on update a field left out keeps its value."
        )
        .optional(),
      amount: z.number().gt(0),
      reference: z.string().optional(),
      notes: z.string().optional(),
      memoId: z.string().optional(),
      customFields: z.unknown().optional(),
      id: z
        .string()
        .describe("Send to update that record; omit to create a new one.")
        .optional()
    })
    .required({ id: true }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.upsertMemo(
        ctx.asCaller.supabase,
        payload(ctx, input).forUpdate() as never
      )
    );
  }
});

/**
 * Get available credits for party
 *
 * @mcp read
 */
export const getAvailableCreditsForParty = defineServiceFn({
  input: z.looseObject({
    party: z.union([
      z.looseObject({ side: z.literal("sales"), customerId: z.string() }),
      z.looseObject({ side: z.literal("purchase"), supplierId: z.string() })
    ]),
    excludePaymentId: z.string().optional(),
    currencyCode: z.string().optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getAvailableCreditsForParty(
        ctx.asCaller.supabase,
        ctx.company.id,
        payload(ctx, input.party).build() as never,
        input.excludePaymentId as never,
        input.currencyCode as never
      )
    );
  }
});

/**
 * Get company has open credits
 *
 * @mcp read
 */
export const getCompanyHasOpenCredits = defineServiceFn({
  input: z.looseObject({ side: z.enum(["sales", "purchase"]) }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return await service.getCompanyHasOpenCredits(
      ctx.asCaller.supabase,
      ctx.company.id,
      input.side as never
    );
  }
});

/**
 * Get staged credits for payment
 *
 * @mcp read
 */
export const getStagedCreditsForPayment = defineServiceFn({
  input: z.looseObject({
    paymentId: z.string(),
    side: z.enum(["sales", "purchase"])
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getStagedCreditsForPayment(
        ctx.asCaller.supabase,
        input.paymentId as never,
        input.side as never,
        ctx.company.id
      )
    );
  }
});

/**
 * Apply credits to invoices
 *
 * @mcp destructive
 */
export const applyCreditsToInvoices = defineServiceFn({
  input: z.looseObject({
    paymentId: z.string(),
    appliedDate: z.string(),
    side: z.enum(["sales", "purchase"]),
    applications: z.array(
      z.looseObject({
        memoId: z.string(),
        invoiceId: z.string(),
        amount: z.number(),
        sourceAmount: z.number().optional()
      })
    )
  }),
  permission: { update: "invoicing" },
  async run(ctx, input) {
    return await service.applyCreditsToInvoices(
      ctx.asSystem.pg,
      payload(ctx, input).forCreate() as never
    );
  }
});

/**
 * Get ar tie out
 *
 * @mcp read
 */
export const getArTieOut = defineServiceFn({
  input: z.looseObject({ asOfDate: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getArTieOut(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.asOfDate as never
      )
    );
  }
});

/**
 * Get ap tie out
 *
 * @mcp read
 */
export const getApTieOut = defineServiceFn({
  input: z.looseObject({ asOfDate: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getApTieOut(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.asOfDate as never
      )
    );
  }
});

/**
 * Get ar open by customer
 *
 * @mcp read
 */
export const getArOpenByCustomer = defineServiceFn({
  input: z.looseObject({ asOfDate: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getArOpenByCustomer(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.asOfDate as never
      )
    );
  }
});

/**
 * Get ap open by supplier
 *
 * @mcp read
 */
export const getApOpenBySupplier = defineServiceFn({
  input: z.looseObject({ asOfDate: z.string() }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getApOpenBySupplier(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.asOfDate as never
      )
    );
  }
});

/**
 * Get ar aging
 *
 * @mcp read
 */
export const getArAging = defineServiceFn({
  input: z.looseObject({
    asOfDate: z.string(),
    options: z
      .looseObject({
        agingMethod: z.enum(["dueDate", "documentDate"]).optional(),
        bucketDays: z.array(z.number()).nullable().optional()
      })
      .optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getArAging(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.asOfDate as never,
        payload(ctx, input.options).build() as never
      )
    );
  }
});

/**
 * Get ap aging
 *
 * @mcp read
 */
export const getApAging = defineServiceFn({
  input: z.looseObject({
    asOfDate: z.string(),
    options: z
      .looseObject({
        agingMethod: z.enum(["dueDate", "documentDate"]).optional(),
        bucketDays: z.array(z.number()).nullable().optional()
      })
      .optional()
  }),
  permission: { view: "invoicing" },
  async run(ctx, input) {
    return unwrap(
      ctx,
      await service.getApAging(
        ctx.asCaller.supabase,
        ctx.company.id,
        input.asOfDate as never,
        payload(ctx, input.options).build() as never
      )
    );
  }
});
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
