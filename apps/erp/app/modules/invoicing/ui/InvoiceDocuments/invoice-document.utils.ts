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
  archived?: boolean;
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

type InvoiceInboxHeader = Pick<
  InvoiceIntakeReview["header"],
  | "sourceSupplierName"
  | "invoiceNumber"
  | "issueDate"
  | "total"
  | "currencyCode"
>;
type InvoiceInboxPayment = {
  payee: string | null;
  reference: string | null;
  transactionDate: string;
  amount: string;
  currencyCode: string;
};
export function invoiceInboxFacts(
  header: InvoiceInboxHeader | null,
  payments: readonly InvoiceInboxPayment[],
  status?: string
) {
  // A retained extraction is not current receipt evidence when the receipt is missing.
  if (status === "NeedsDocument") header = null;
  const fact = (
    value: string | null | undefined,
    candidates: (string | null)[],
    distinct = true
  ) => {
    if (value?.trim()) return { value, fromPayment: false };
    const values = candidates.filter(
      (candidate): candidate is string => !!candidate?.trim()
    );
    const fallback =
      (distinct ? [...new Set(values)] : values).join(" · ") || null;
    return { value: fallback, fromPayment: fallback !== null };
  };
  return {
    supplier: fact(
      header?.sourceSupplierName,
      payments.map((payment) => payment.payee)
    ),
    reference: fact(
      header?.invoiceNumber,
      payments.map((payment) => payment.reference)
    ),
    date: fact(
      header?.issueDate,
      payments.map((payment) => payment.transactionDate)
    ),
    amount: fact(
      header?.total
        ? `${header.currencyCode ?? ""} ${header.total}`.trim()
        : null,
      payments.map((payment) => `${payment.currencyCode} ${payment.amount}`),
      false
    )
  };
}

export type InvoiceReceiptAcknowledgement = {
  mercuryImportId: string;
  attachmentId: string;
  fingerprint: string;
  reason: string;
};
export function invoiceReceiptReason(
  acknowledgements: readonly InvoiceReceiptAcknowledgement[],
  mercuryImportId: string,
  attachmentId: string,
  fingerprint: string
) {
  return (
    acknowledgements.find(
      (entry) =>
        entry.mercuryImportId === mercuryImportId &&
        entry.attachmentId === attachmentId &&
        entry.fingerprint === fingerprint
    )?.reason ?? null
  );
}
