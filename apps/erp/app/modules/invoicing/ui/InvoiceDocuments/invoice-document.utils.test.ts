import { describe, expect, it } from "vitest";
import {
  type InvoicePreviewSource,
  invoiceCountryCode,
  invoiceItemProposalUnit,
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
