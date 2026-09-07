import { emptyInvoiceExtraction } from "@carbon/jobs";
import { describe, expect, it } from "vitest";
import {
  extractionToInvoiceReview,
  getInvoiceIntakeTransition,
  getInvoicePaymentReconciliation,
  type InvoiceReviewContext,
  updateInvoiceReviewLine,
  validateInvoiceReview
} from "./invoice-intake.utils";
import {
  type InvoiceIntakeReview,
  invoiceIntakeReviewValidator
} from "./invoicing.models";

const context: InvoiceReviewContext = {
  baseCurrencyCode: "USD",
  currencyDecimalPlaces: 2,
  supportedUnits: ["EA", "BAG"],
  items: new Map([
    ["test-item", { type: "Consumable", active: true, unitOfMeasureCode: "EA" }]
  ]),
  canCreateSupplier: true,
  canCreateItemTypes: ["Part", "Material", "Consumable", "Tool", "Service"],
  supplierAllowed: true,
  linkedInvoiceStatus: null,
  linkedInvoiceHasLines: false,
  duplicateInvoiceIds: []
};
function review(): InvoiceIntakeReview {
  return invoiceIntakeReviewValidator.parse({
    documentKind: "invoice",
    supplierId: "test-supplier",
    locationId: "test-location",
    header: {
      invoiceNumber: "EXAMPLE-1",
      issueDate: "2026-02-28",
      currencyCode: "USD",
      subtotal: "10",
      total: "10",
      chargesConfirmed: true
    },
    lines: [
      {
        lineKey: "1",
        sortOrder: 0,
        description: "M4 fasteners",
        quantity: "2",
        supplierUnitPrice: "5",
        itemId: "test-item",
        lineType: "Consumable",
        purchaseUnit: "BAG",
        stockUnit: "EA",
        conversionFactor: "100",
        locationId: "test-location"
      }
    ]
  });
}
describe("invoice review readiness", () => {
  it("couples reviewed tax edits at the configured currency precision", () => {
    const line = {
      ...review().lines[0],
      supplierShippingCost: "0",
      supplierTaxAmount: "0",
      taxPercent: "0"
    };
    const taxed = updateInvoiceReviewLine(
      line,
      { taxPercent: "0.0625" },
      context.currencyDecimalPlaces
    );
    expect(taxed.supplierTaxAmount).toBe("0.63");
    expect(
      updateInvoiceReviewLine(
        taxed,
        { quantity: "4" },
        context.currencyDecimalPlaces
      ).supplierTaxAmount
    ).toBe("1.25");
    expect(
      updateInvoiceReviewLine(
        taxed,
        { supplierTaxAmount: "0.5" },
        context.currencyDecimalPlaces
      ).taxPercent
    ).toBe("0.05");
  });
  it("preserves missing source charges rather than assuming zero when reviewing tax", () => {
    const line = {
      ...review().lines[0],
      supplierShippingCost: null,
      supplierTaxAmount: null,
      taxPercent: null
    };
    expect(
      updateInvoiceReviewLine(
        line,
        { taxPercent: "0.0625" },
        context.currencyDecimalPlaces
      ).supplierTaxAmount
    ).toBeNull();
  });
  it("accepts explicit valid pack conversion and preserves current financial facts", () => {
    expect(validateInvoiceReview(review(), context)).toMatchObject({
      ready: true,
      computedTotal: 10,
      newItemCount: 0
    });
  });
  it("leaves missing prices and quantities unresolved", () => {
    const value = review();
    value.lines[0].quantity = null;
    value.lines[0].supplierUnitPrice = null;
    expect(
      validateInvoiceReview(value, context).issues.map((issue) => issue.code)
    ).toEqual(expect.arrayContaining(["quantity", "price", "total"]));
  });
  it.each([
    "2026-02-30",
    "02/03/2026",
    "2026-2-3"
  ])("rejects ambiguous/invalid date %s", (date) => {
    const value = review();
    value.header.issueDate = date;
    expect(
      validateInvoiceReview(value, context).issues.some(
        (issue) => issue.code === "date"
      )
    ).toBe(true);
  });
  it("handles zero-decimal and three-decimal currencies at settlement precision", () => {
    const value = review();
    value.header.currencyCode = "JPY";
    value.header.exchangeRate = "0.0068";
    value.header.subtotal = "10.4";
    value.lines[0].supplierUnitPrice = "5.2";
    expect(
      validateInvoiceReview(value, { ...context, currencyDecimalPlaces: 0 })
        .ready
    ).toBe(true);
    value.header.currencyCode = "KWD";
    value.header.subtotal = "10.002";
    value.header.total = "10.002";
    value.lines[0].supplierUnitPrice = "5.001";
    expect(
      validateInvoiceReview(value, { ...context, currencyDecimalPlaces: 3 })
        .ready
    ).toBe(true);
    value.header.exchangeRate = null;
    expect(
      validateInvoiceReview(value, context).issues.some(
        (issue) => issue.code === "fx"
      )
    ).toBe(true);
  });
  it("refuses type rewrites, pack mistakes, ambiguous duplicates, and unallocated tax", () => {
    const value = review();
    value.lines[0].lineType = "Part";
    value.lines[0].purchaseUnit = "EA";
    value.header.tax = "2";
    const checked = validateInvoiceReview(value, {
      ...context,
      duplicateInvoiceIds: ["another-invoice"]
    });
    expect(checked.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["item", "conversion", "duplicate", "tax"])
    );
  });
  it("rejects unsupported credit/statement documents and absent references unless confirmed", () => {
    const value = review();
    value.documentKind = "statement";
    value.header.invoiceNumber = null;
    expect(
      validateInvoiceReview(value, context).issues.map((issue) => issue.code)
    ).toEqual(expect.arrayContaining(["kind", "reference"]));
    value.documentKind = "receipt";
    value.header.noInvoiceNumberConfirmed = true;
    expect(validateInvoiceReview(value, context).ready).toBe(true);
  });
  it("requires a supported explicit net-price representation of discounts", () => {
    const value = review();
    value.header.discount = "2";
    value.header.total = "8";
    value.lines[0].discountAmount = "2";
    expect(validateInvoiceReview(value, context).ready).toBe(false);
    value.lines[0].supplierUnitPrice = "4";
    value.lines[0].review.discountIncludedInPrice = true;
    expect(validateInvoiceReview(value, context).ready).toBe(true);
  });
  it("handles non-Draft evidence without manufacturing a financial review", () => {
    const value = invoiceIntakeReviewValidator.parse({
      mergeMode: "evidence",
      purchaseInvoiceId: "existing-invoice",
      header: {},
      lines: []
    });
    expect(
      validateInvoiceReview(value, { ...context, linkedInvoiceStatus: "Paid" })
        .ready
    ).toBe(true);
    value.newSupplier = { supplier: { name: "Example Supplier" } };
    expect(
      validateInvoiceReview(value, { ...context, linkedInvoiceStatus: "Paid" })
        .ready
    ).toBe(false);
  });
  it("keeps empty extraction incomplete", () => {
    const parsed = extractionToInvoiceReview(emptyInvoiceExtraction());
    expect(parsed.header.issueDate).toBeNull();
    expect(parsed.lines).toEqual([]);
    expect(validateInvoiceReview(parsed, context).ready).toBe(false);
  });
  it("guards state transitions and never edits an approved document", () => {
    expect(() => getInvoiceIntakeTransition("Approved", "retry")).toThrow();
    expect(() =>
      getInvoiceIntakeTransition("NeedsReview", "approve")
    ).toThrow();
    expect(getInvoiceIntakeTransition("Ready", "approve")).toBe("Approved");
    expect(getInvoiceIntakeTransition("Ignored", "restore")).toBe(
      "NeedsReview"
    );
  });
});

describe("Mercury payment reconciliation", () => {
  it("compares receipt totals with all linked payments without changing source values", () => {
    const value = review();
    const payments = [
      { amount: "4", currencyCode: "USD" },
      { amount: "6", currencyCode: "USD" }
    ];
    expect(
      getInvoicePaymentReconciliation(value.header, payments, 2)
    ).toMatchObject({ status: "matched", paymentTotal: "10", difference: "0" });
    expect(
      getInvoicePaymentReconciliation(
        value.header,
        [{ amount: "12", currencyCode: "USD" }],
        2
      )
    ).toMatchObject({
      status: "difference",
      paymentTotal: "12",
      difference: "2"
    });
    expect(value.header.total).toBe("10");
  });
  it("does not compare different currencies or manufacture missing totals", () => {
    expect(
      getInvoicePaymentReconciliation(
        review().header,
        [{ amount: "10", currencyCode: "EUR" }],
        2
      ).status
    ).toBe("currencyMismatch");
    expect(
      getInvoicePaymentReconciliation(
        { ...review().header, total: null },
        [{ amount: "10", currencyCode: "USD" }],
        2
      ).status
    ).toBe("unavailable");
    expect(getInvoicePaymentReconciliation(review().header, [], 2).status).toBe(
      "unavailable"
    );
  });
});

it("does not describe a pending or reversed bank transaction as matched payment", () => {
  for (const remoteStatus of ["pending", "failed", "reversed", "cancelled"])
    expect(
      getInvoicePaymentReconciliation(
        review().header,
        [{ amount: "10", currencyCode: "USD", remoteStatus }],
        2
      ).status
    ).toBe("unsettled");
  expect(
    getInvoicePaymentReconciliation(
      review().header,
      [{ amount: "10", currencyCode: "USD", remoteStatus: "sent" }],
      2
    ).status
  ).toBe("matched");
});
