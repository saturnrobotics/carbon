import type {
  InvoiceExtractionEnvelope,
  InvoiceIntakeStatus,
  InvoiceItemType
} from "@carbon/jobs";
import { invoiceItemTypes } from "@carbon/jobs";
import {
  applyRate,
  isBalanced as equals,
  round,
  taxableBase,
  taxPairFromAmount,
  taxPairFromPercent
} from "@carbon/utils";
import { parseDate } from "@internationalized/date";
import {
  type InvoiceIntakeReview,
  type InvoiceIntakeReviewLine,
  invoiceIntakeReviewValidator
} from "./invoicing.models";

export type InvoiceReviewIssue = {
  path: string;
  code: string;
  message: string;
};
export type ReviewValidation = {
  ready: boolean;
  issues: InvoiceReviewIssue[];
  computedTotal: number | null;
  newSupplierCount: number;
  newItemCount: number;
};
export type InvoiceReviewContext = {
  baseCurrencyCode: string;
  currencyDecimalPlaces: number | null;
  supportedUnits: readonly string[];
  items: ReadonlyMap<
    string,
    { type: string; active: boolean; unitOfMeasureCode: string | null }
  >;
  canCreateSupplier: boolean;
  canCreateItemTypes: readonly InvoiceItemType[];
  supplierAllowed: boolean;
  linkedInvoiceStatus: string | null;
  linkedInvoiceHasLines: boolean;
  duplicateInvoiceIds: readonly string[];
  validateNewSupplier?: (
    proposal: NonNullable<InvoiceIntakeReview["newSupplier"]>
  ) => string[];
  validateNewItem?: (
    proposal: NonNullable<InvoiceIntakeReviewLine["newItem"]>
  ) => string[];
};

/** Explicit review edits use Carbon's native tax pair. Never turn absent facts
 * into zero just to calculate a pair. Source extraction stays immutable. */
export function updateInvoiceReviewLine(
  line: InvoiceIntakeReviewLine,
  change: Partial<InvoiceIntakeReviewLine>,
  currencyDecimals: number | null
): InvoiceIntakeReviewLine {
  const next = {
    ...line,
    ...change,
    review: { ...line.review, origin: "manual" as const, ...change.review }
  };
  if (
    currencyDecimals === null ||
    [next.quantity, next.supplierUnitPrice, next.supplierShippingCost].some(
      (value) => value === null || !Number.isFinite(Number(value))
    )
  )
    return next;
  const base = taxableBase(
    Number(next.supplierUnitPrice),
    Number(next.quantity),
    Number(next.supplierShippingCost)
  );
  if (change.supplierTaxAmount !== undefined) {
    if (change.supplierTaxAmount === null) return { ...next, taxPercent: null };
    const pair = taxPairFromAmount(
      base,
      Number(change.supplierTaxAmount),
      Number(next.taxPercent ?? 0)
    );
    return {
      ...next,
      supplierTaxAmount: String(pair.amount),
      taxPercent: String(pair.percent)
    };
  }
  if (change.taxPercent === null) return { ...next, supplierTaxAmount: null };
  if (
    next.taxPercent !== null &&
    [
      "taxPercent",
      "quantity",
      "supplierUnitPrice",
      "supplierShippingCost"
    ].some((key) => key in change)
  ) {
    const pair = taxPairFromPercent(
      base,
      Number(next.taxPercent),
      currencyDecimals
    );
    return {
      ...next,
      supplierTaxAmount: String(pair.amount),
      taxPercent: String(pair.percent)
    };
  }
  return next;
}

export function invoiceProposalKey(
  proposal: NonNullable<InvoiceIntakeReviewLine["newItem"]>
): string {
  // Stable, complete identity: differing taxonomy/custom values cannot collapse together.
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, stable(val)])
      );
    return value;
  };
  return JSON.stringify(stable(proposal));
}

export function validateInvoiceReview(
  review: InvoiceIntakeReview,
  context: InvoiceReviewContext
): ReviewValidation {
  const issues: InvoiceReviewIssue[] = [];
  const add = (path: string, code: string, message: string) => {
    issues.push({ path, code, message });
  };
  const valid = invoiceIntakeReviewValidator.safeParse(review);
  if (!valid.success) {
    for (const issue of valid.error.issues)
      add(issue.path.join("."), "invalid", issue.message);
    return {
      ready: false,
      issues,
      computedTotal: null,
      newSupplierCount: 0,
      newItemCount: 0
    };
  }
  const data = valid.data;
  const { header } = data;
  const newKeys = new Set(
    data.lines.flatMap((line) =>
      line.newItem ? [invoiceProposalKey(line.newItem)] : []
    )
  );
  const result = (computedTotal: number | null): ReviewValidation => ({
    ready: issues.length === 0,
    issues,
    computedTotal,
    newSupplierCount: data.newSupplier ? 1 : 0,
    newItemCount: newKeys.size
  });
  if (data.mergeMode === "evidence") {
    if (!data.purchaseInvoiceId || !context.linkedInvoiceStatus)
      add("purchaseInvoiceId", "invoice", "Choose an invoice to link evidence");
    if (data.newSupplier || newKeys.size)
      add(
        "mergeMode",
        "evidence",
        "Evidence linking cannot create suppliers or items"
      );
    return result(null);
  }
  if (!["invoice", "receipt"].includes(data.documentKind))
    add(
      "documentKind",
      "kind",
      "Select a single invoice or receipt; split statements, credits, and multiple invoices for manual handling"
    );
  if (!data.supplierId && !data.newSupplier)
    add("supplierId", "supplier", "Choose or propose a supplier");
  if (data.supplierId && !context.supplierAllowed)
    add(
      "supplierId",
      "supplier",
      "Supplier is unavailable or requires approval"
    );
  if (data.newSupplier) {
    if (!context.canCreateSupplier)
      add(
        "newSupplier",
        "permission",
        "Supplier creation permission is required"
      );
    for (const issue of context.validateNewSupplier?.(data.newSupplier) ?? [])
      add("newSupplier", "supplier", issue);
  }
  const date = (value: string | null, path: string, required: boolean) => {
    if (!value) {
      if (required)
        add(path, "date", "An unambiguous invoice date is required");
      return null;
    }
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("format");
      return parseDate(value);
    } catch {
      add(path, "date", "Use a valid date in YYYY-MM-DD format");
      return null;
    }
  };
  const issued = date(header.issueDate, "header.issueDate", true);
  const due = date(header.dueDate, "header.dueDate", false);
  if (issued && due && due.compare(issued) < 0)
    add("header.dueDate", "date", "Due date precedes the invoice date");
  if (!header.invoiceNumber?.trim() && !header.noInvoiceNumberConfirmed)
    add(
      "header.invoiceNumber",
      "reference",
      "Enter the invoice number or confirm that the receipt has none"
    );
  const precision = context.currencyDecimalPlaces;
  if (
    !header.currencyCode ||
    precision === null ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 8
  )
    add("header.currencyCode", "currency", "Select a configured currency");
  if (
    header.currencyCode !== context.baseCurrencyCode &&
    (!header.exchangeRate || Number(header.exchangeRate) <= 0)
  )
    add(
      "header.exchangeRate",
      "fx",
      "Confirm the historical exchange rate for this currency"
    );
  if (header.exchangeRate !== null && Number(header.exchangeRate) <= 0)
    add("header.exchangeRate", "fx", "Exchange rate must be positive");
  if (!data.locationId)
    add("locationId", "location", "Select the invoice location");
  if (header.total === null || Number(header.total) < 0)
    add("header.total", "total", "Enter the document's nonnegative total");
  if (header.sourceIssues.length && !header.resolvedSourceIssues)
    add(
      "header.sourceIssues",
      "source",
      "Resolve the document extraction issues and confirm the source is complete"
    );
  if (!header.chargesConfirmed)
    add(
      "header.chargesConfirmed",
      "charges",
      "Confirm how the document's tax, discount, and shipping are represented"
    );
  if (context.linkedInvoiceStatus && context.linkedInvoiceStatus !== "Draft")
    add(
      "purchaseInvoiceId",
      "locked",
      "This invoice accepts evidence only because it is no longer Draft"
    );
  if (context.linkedInvoiceHasLines && data.mergeMode !== "merge")
    add(
      "mergeMode",
      "merge",
      "Review explicit line mappings before enriching a populated draft"
    );
  if (data.mergeMode === "merge" && !data.expectedInvoiceUpdatedAt)
    add(
      "expectedInvoiceUpdatedAt",
      "revision",
      "Refresh and review the current draft before merging"
    );
  if (
    context.duplicateInvoiceIds.some((id) => id !== data.purchaseInvoiceId) &&
    !header.duplicateOverrideReason?.trim()
  )
    add(
      "purchaseInvoiceId",
      "duplicate",
      "Link the existing invoice or record why this is a different purchase"
    );
  if (!data.lines.length)
    add("lines", "lines", "Add the document's line items");
  const keys = new Set<string>();
  let net = 0,
    tax = 0,
    shipping = 0,
    discount = 0,
    financialLines = 0;
  const amount = (value: string | null) => (value === null ? 0 : Number(value));
  for (const [index, line] of data.lines.entries()) {
    const path = `lines.${index}`;
    if (keys.has(line.lineKey))
      add(
        `${path}.lineKey`,
        "identity",
        "Each source line must have a distinct identity"
      );
    keys.add(line.lineKey);
    if (!line.description?.trim())
      add(`${path}.description`, "description", "Enter the line description");
    if (!line.lineType)
      add(`${path}.lineType`, "type", "Select the appropriate line type");
    if (line.lineType === "Comment") {
      if (
        !line.review.commentConfirmed ||
        [
          line.quantity,
          line.supplierUnitPrice,
          line.documentLineTotal,
          line.supplierTaxAmount,
          line.supplierShippingCost
        ].some((value) => value !== null && Number(value) !== 0)
      )
        add(
          path,
          "comment",
          "Only explicitly confirmed nonfinancial source lines can be comments"
        );
      continue;
    }
    financialLines++;
    if (line.quantity === null || Number(line.quantity) <= 0)
      add(`${path}.quantity`, "quantity", "Enter a positive purchase quantity");
    if (line.supplierUnitPrice === null || Number(line.supplierUnitPrice) < 0)
      add(
        `${path}.supplierUnitPrice`,
        "price",
        "Enter the document's unit price"
      );
    for (const key of [
      "discountAmount",
      "supplierTaxAmount",
      "supplierShippingCost"
    ] as const) {
      if (line[key] !== null && Number(line[key]) < 0)
        add(
          `${path}.${key}`,
          "amount",
          "Credits need explicit manual handling"
        );
    }
    if (invoiceItemTypes.includes(line.lineType as InvoiceItemType)) {
      if (!line.itemId && !line.newItem)
        add(
          `${path}.itemId`,
          "item",
          "Choose an item or complete a new item proposal"
        );
      const selected = line.itemId ? context.items.get(line.itemId) : null;
      if (line.itemId && (!selected?.active || selected.type !== line.lineType))
        add(
          `${path}.itemId`,
          "item",
          "Selected item is unavailable or has a different native type"
        );
      if (line.newItem) {
        if (line.newItem.type !== line.lineType)
          add(`${path}.newItem`, "type", "Proposal type must match the line");
        if (!context.canCreateItemTypes.includes(line.newItem.type))
          add(
            `${path}.newItem`,
            "permission",
            "Item creation permission is required for this class"
          );
        for (const issue of context.validateNewItem?.(line.newItem) ?? [])
          add(`${path}.newItem`, "item", issue);
      }
      if (
        !line.purchaseUnit ||
        !line.stockUnit ||
        !context.supportedUnits.includes(line.purchaseUnit) ||
        !context.supportedUnits.includes(line.stockUnit)
      )
        add(
          `${path}.purchaseUnit`,
          "unit",
          "Select valid purchase and inventory units"
        );
      if (
        selected?.unitOfMeasureCode &&
        selected.unitOfMeasureCode !== line.stockUnit
      )
        add(
          `${path}.stockUnit`,
          "unit",
          "Inventory unit must match the selected item"
        );
      if (
        !line.conversionFactor ||
        Number(line.conversionFactor) <= 0 ||
        (line.purchaseUnit === line.stockUnit &&
          Number(line.conversionFactor) !== 1)
      )
        add(
          `${path}.conversionFactor`,
          "conversion",
          "Confirm a positive pack conversion; equal units require a factor of one"
        );
      if (line.lineType !== "Service" && !line.locationId)
        add(`${path}.locationId`, "location", "Select an inventory location");
    }
    if (line.lineType === "G/L Account" && !line.accountId)
      add(`${path}.accountId`, "account", "Choose an expense account");
    if (
      line.lineType === "Fixed Asset" &&
      (!line.assetId || Number(line.quantity) !== 1)
    )
      add(`${path}.assetId`, "asset", "Choose an asset with a quantity of one");
    if (line.review.replaceRuleId && !line.review.replacementReason?.trim())
      add(
        `${path}.review.replacementReason`,
        "rule",
        "Explain the correction before replacing a saved match"
      );
    const lineNet = amount(line.quantity) * amount(line.supplierUnitPrice);
    const lineDiscount = amount(line.discountAmount);
    if (lineDiscount && !line.review.discountIncludedInPrice)
      add(
        `${path}.discountAmount`,
        "discount",
        "Represent the discount in the native net unit price and confirm the allocation"
      );
    if (
      line.taxPercent !== null &&
      (Number(line.taxPercent) < 0 || Number(line.taxPercent) > 1)
    )
      add(`${path}.taxPercent`, "tax", "Tax rate must be between zero and one");
    if (
      precision !== null &&
      line.taxPercent !== null &&
      !equals(
        applyRate(
          lineNet + amount(line.supplierShippingCost),
          Number(line.taxPercent),
          precision
        ),
        round(amount(line.supplierTaxAmount), precision)
      )
    )
      add(
        `${path}.supplierTaxAmount`,
        "tax",
        "Tax rate and tax amount do not agree"
      );
    const lineTotal =
      lineNet +
      amount(line.supplierTaxAmount) +
      amount(line.supplierShippingCost);
    if (
      precision !== null &&
      line.documentLineTotal !== null &&
      !equals(
        round(lineTotal, precision),
        round(Number(line.documentLineTotal), precision)
      )
    )
      add(
        `${path}.documentLineTotal`,
        "lineTotal",
        "Computed line total differs from the source total"
      );
    net += lineNet;
    tax += amount(line.supplierTaxAmount);
    shipping += amount(line.supplierShippingCost);
    discount += lineDiscount;
  }
  if (!financialLines)
    add("lines", "lines", "At least one financial line is required");
  if (precision === null) return result(null);
  if (
    header.discount !== null &&
    !equals(
      round(discount, precision),
      round(Number(header.discount), precision)
    )
  )
    add(
      "header.discount",
      "discount",
      "Allocate the document discount explicitly across the line net prices"
    );
  if (
    header.tax !== null &&
    !equals(round(tax, precision), round(Number(header.tax), precision))
  )
    add("header.tax", "tax", "Allocate the document tax across its lines");
  if (
    header.subtotal !== null &&
    !equals(
      round(net + discount, precision),
      round(Number(header.subtotal), precision)
    )
  )
    add(
      "header.subtotal",
      "subtotal",
      "Line amounts and discounts do not reconcile with the document subtotal"
    );
  // Header shipping is the amount not already allocated to lines; both are visible.
  const computedTotal = round(
    net + tax + shipping + amount(header.shipping),
    precision
  );
  if (
    header.total !== null &&
    !equals(computedTotal, round(Number(header.total), precision))
  )
    add(
      "header.total",
      "total",
      "Line amounts, tax, discount, and shipping do not reconcile with the document total"
    );
  return result(computedTotal);
}

export function getInvoiceReviewReadiness(
  review: InvoiceIntakeReview,
  context: InvoiceReviewContext
) {
  const validation = validateInvoiceReview(review, context);
  return {
    status: validation.ready ? ("Ready" as const) : ("NeedsReview" as const),
    ...validation
  };
}

export function getInvoiceIntakeTransition(
  current: InvoiceIntakeStatus,
  action: "save" | "approve" | "link" | "retry" | "ignore" | "restore"
): InvoiceIntakeStatus {
  if (current === "Approved" || current === "Linked")
    throw new Error("Approved intake is immutable");
  if (action === "restore") {
    if (current !== "Ignored")
      throw new Error("Only ignored intake can be restored");
    return "NeedsReview";
  }
  if (current === "Ignored" && action !== "ignore")
    throw new Error("Restore the ignored intake first");
  if (action === "ignore") return "Ignored";
  if (action === "retry") return "Queued";
  if (action === "approve" || action === "link") {
    if (current !== "Ready")
      throw new Error("Resolve review issues before approval");
    return action === "link" ? "Linked" : "Approved";
  }
  return "NeedsReview";
}

export function extractionToInvoiceReview(
  extraction: InvoiceExtractionEnvelope
): InvoiceIntakeReview {
  return invoiceIntakeReviewValidator.parse({
    documentKind: extraction.documentKind,
    header: {
      ...Object.fromEntries(
        Object.entries(extraction.header).map(([key, field]) => [
          key,
          field.value
        ])
      ),
      sourceSupplierName: extraction.supplier.name.value,
      sourceIssues: extraction.issues
    },
    lines: extraction.lines.map((line, index) => ({
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
      purchaseUnit: line.purchaseUnit.value,
      lineType: line.suggestedType.value,
      review: { origin: "document" }
    }))
  });
}
