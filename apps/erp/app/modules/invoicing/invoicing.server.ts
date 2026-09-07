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
  invoiceIntakeStatuses,
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
  invoiceProposalKey
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
    .select(["id", "kind", "sha256", "storagePath", "mercuryImportId"])
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
  const payments = importedPayments.map((payment) => ({
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
    receiptAcquisition:
      parseMercuryVendorSuggestion(payment.vendorSuggestion)
        .mercuryReceiptAcquisition ?? null
  }));
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
    !review.header.paymentReviewReason?.trim()
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
  if (
    input.status &&
    invoiceIntakeStatuses.includes(input.status as InvoiceIntakeStatus)
  )
    query = query.where("status", "=", input.status);
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
  const [sourceBadges, itemCounts] = intakeIds.length
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
          .execute()
      ])
    : [[], []];
  return {
    intakes: intakes.slice(0, 50).map((row) => ({
      ...row,
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
        THEN jsonb_build_object('_defaults',header->'_defaults') ELSE '{}'::jsonb END`,
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
