import type {
  InvoiceIntakeReview,
  InvoiceIntakeReviewLine
} from "../../invoicing.models";

export type InvoicePreviewSource = {
  id: string;
  sha256: string | null;
  storagePath: string | null;
  fileName: string | null;
  mediaType: string | null;
  url: string | null;
};

export function selectInvoicePreviewSource<T extends InvoicePreviewSource>(
  sources: T[],
  selectedId: string | null,
  primarySha256: string | null
): T | undefined {
  const files = sources.filter((source) => source.storagePath && source.sha256);
  return (
    files.find((source) => source.id === selectedId) ??
    files.find((source) => primarySha256 && source.sha256 === primarySha256) ??
    files.find((source) => source.url) ??
    files[0]
  );
}

export function invoiceSupplierProposalDefaults(
  review: Pick<InvoiceIntakeReview, "newSupplier"> & {
    header: Pick<
      InvoiceIntakeReview["header"],
      "sourceSupplierName" | "currencyCode"
    >;
  },
  extraction: { supplier: { name: { value: string | null } } } | null
) {
  return {
    name: String(
      review.newSupplier?.supplier.name ??
        review.header.sourceSupplierName ??
        extraction?.supplier.name.value ??
        ""
    ),
    currencyCode: review.header.currencyCode ?? undefined,
    ...review.newSupplier?.supplier
  };
}

export function invoiceItemProposalUnit(
  line: Pick<InvoiceIntakeReviewLine, "stockUnit" | "purchaseUnit">,
  units: readonly string[]
) {
  return (
    line.stockUnit ??
    (line.purchaseUnit && units.includes(line.purchaseUnit)
      ? line.purchaseUnit
      : "")
  );
}

export function invoiceCountryCode(
  value: string | null,
  countries: readonly { value: string; label: string }[]
) {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  const matches = countries.filter(
    (country) =>
      country.value.toLowerCase() === normalized ||
      country.label.trim().toLowerCase() === normalized
  );
  return matches.length === 1 ? matches[0].value : value;
}
