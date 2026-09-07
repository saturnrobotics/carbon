import { describe, expect, it } from "vitest";
import {
  type InvoicePreviewSource,
  invoiceCountryCode,
  invoiceInboxFacts,
  invoiceItemProposalUnit,
  invoiceReceiptReason,
  invoiceSupplierProposalDefaults,
  selectInvoicePreviewSource
} from "./invoice-document.utils";

const placeholder: InvoicePreviewSource = {
  id: "payment",
  sha256: null,
  storagePath: null,
  fileName: null,
  mediaType: null,
  url: null
};
const receipt: InvoicePreviewSource = {
  id: "receipt",
  sha256: "receipt-hash",
  storagePath: "company/invoice-intake/receipt.pdf",
  fileName: "receipt.pdf",
  mediaType: "application/pdf",
  url: "https://example.com/receipt"
};

describe("invoice review presentation", () => {
  it("uses bank facts for missing-document follow-up even when an older extraction header remains", () => {
    const facts = invoiceInboxFacts(
      {
        sourceSupplierName: "Old parsed supplier",
        invoiceNumber: "OLD-REF",
        issueDate: "2026-01-01",
        total: "100",
        currencyCode: "EUR"
      },
      [
        {
          payee: "Current bank payee",
          reference: "BANK-REF",
          transactionDate: "2026-02-02",
          amount: "42",
          currencyCode: "USD"
        }
      ],
      "NeedsDocument"
    );
    expect(facts.supplier).toEqual({
      value: "Current bank payee",
      fromPayment: true
    });
    expect(facts.amount).toEqual({ value: "USD 42", fromPayment: true });
  });
  it("does not reuse an attachment explanation after its fingerprint or payment changes", () => {
    const entries = [
      {
        mercuryImportId: "payment-a",
        attachmentId: "file-1",
        fingerprint: "old",
        reason: "Supporting evidence only"
      }
    ];
    expect(
      invoiceReceiptReason(entries, "payment-a", "file-1", "new")
    ).toBeNull();
    expect(
      invoiceReceiptReason(entries, "payment-b", "file-1", "old")
    ).toBeNull();
    expect(invoiceReceiptReason(entries, "payment-a", "file-1", "old")).toBe(
      "Supporting evidence only"
    );
  });
  it("labels bank metadata as payment evidence when parsed invoice facts are absent", () => {
    const facts = invoiceInboxFacts(null, [
      {
        payee: "Example Seller",
        reference: "BANK-17",
        transactionDate: "2026-02-03",
        amount: "25.50",
        currencyCode: "USD"
      }
    ]);
    expect(facts.supplier).toEqual({
      value: "Example Seller",
      fromPayment: true
    });
    expect(facts.reference).toEqual({ value: "BANK-17", fromPayment: true });
    expect(facts.date).toEqual({ value: "2026-02-03", fromPayment: true });
    expect(facts.amount).toEqual({ value: "USD 25.50", fromPayment: true });
  });
  it("keeps invoice facts distinct and does not add unrelated payment amounts or currencies", () => {
    const payments = [
      {
        payee: "Bank Payee",
        reference: null,
        transactionDate: "2026-02-03",
        amount: "10",
        currencyCode: "USD"
      },
      {
        payee: "Second Payee",
        reference: null,
        transactionDate: "2026-02-04",
        amount: "20",
        currencyCode: "EUR"
      }
    ];
    expect(invoiceInboxFacts(null, payments).amount).toEqual({
      value: "USD 10 · EUR 20",
      fromPayment: true
    });
    const facts = invoiceInboxFacts(
      {
        sourceSupplierName: "Invoice Supplier",
        invoiceNumber: "INV-2",
        issueDate: "2026-01-01",
        total: "0",
        currencyCode: "GBP"
      },
      payments
    );
    expect(facts.supplier).toEqual({
      value: "Invoice Supplier",
      fromPayment: false
    });
    expect(facts.amount).toEqual({ value: "GBP 0", fromPayment: false });
  });
  it("maps an extracted country name or code to the configured country code, preserving unknown text", () => {
    const countries = [
      { value: "CA", label: "Canada" },
      { value: "US", label: "United States" }
    ];
    expect(invoiceCountryCode(" canada ", countries)).toBe("CA");
    expect(invoiceCountryCode("us", countries)).toBe("US");
    expect(invoiceCountryCode("Example unknown country", countries)).toBe(
      "Example unknown country"
    );
    expect(invoiceCountryCode(null, countries)).toBeNull();
  });
  it("does not present payment metadata as a missing receipt when a file exists", () => {
    expect(
      selectInvoicePreviewSource([placeholder, receipt], null, null)?.id
    ).toBe("receipt");
  });
  it("moves an old placeholder selection to the first arriving receipt", () => {
    expect(
      selectInvoicePreviewSource(
        [placeholder, receipt],
        "payment",
        receipt.sha256
      )?.id
    ).toBe("receipt");
  });
  it("returns no previewable source for a payment-only record", () => {
    expect(
      selectInvoicePreviewSource([placeholder], null, null)
    ).toBeUndefined();
  });
  it("keeps an explicitly selected unavailable file distinguishable from no attachment", () => {
    const unavailable = { ...receipt, id: "unavailable", url: null };
    expect(
      selectInvoicePreviewSource(
        [receipt, unavailable],
        unavailable.id,
        receipt.sha256
      )
    ).toEqual(unavailable);
  });
  it("prefills an extracted vendor even when a preserved review has no copied vendor name", () => {
    const review = {
      header: { sourceSupplierName: null, currencyCode: "USD" },
      newSupplier: null
    };
    const extraction = {
      supplier: { name: { value: "Example Supplies" } }
    };
    expect(invoiceSupplierProposalDefaults(review, extraction).name).toBe(
      "Example Supplies"
    );
  });
  it("preserves an operator's supplier proposal over parsed suggestions", () => {
    const review = {
      header: { sourceSupplierName: "Source name", currencyCode: "USD" },
      newSupplier: { supplier: { name: "Reviewed name" } }
    };
    expect(invoiceSupplierProposalDefaults(review, null).name).toBe(
      "Reviewed name"
    );
  });
  it("prefills a configured purchase unit for a new item without inventing a pack conversion", () => {
    expect(
      invoiceItemProposalUnit({ stockUnit: null, purchaseUnit: "EA" }, [
        "EA",
        "BOX"
      ])
    ).toBe("EA");
    expect(
      invoiceItemProposalUnit({ stockUnit: null, purchaseUnit: "pack of 50" }, [
        "EA",
        "BOX"
      ])
    ).toBe("");
    expect(
      invoiceItemProposalUnit({ stockUnit: "BOX", purchaseUnit: "EA" }, [
        "EA",
        "BOX"
      ])
    ).toBe("BOX");
  });
});
