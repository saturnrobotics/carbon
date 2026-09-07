import {
  emptyInvoiceExtraction,
  emptyInvoiceEvidence as evidence,
  type InvoiceExtractionEnvelope,
  type InvoiceItemType
} from "../contracts";
export type InvoiceFixture = {
  id: string;
  format: "pdf" | "scan" | "photo";
  pages: string[][];
  labels: InvoiceExtractionEnvelope;
  duplicateOf?: string;
  heldOutRepeat: boolean;
};
const products: Array<{
  description: string;
  sku: string;
  type: InvoiceItemType;
  unit: string;
  pack: string | null;
}> = [
  {
    description: "Steel mounting bracket revision B",
    sku: "BRK-001-B",
    type: "Part",
    unit: "EA",
    pack: null
  },
  {
    description: "Aluminum sheet 6061-T6 2 mm",
    sku: "AL-6061-2",
    type: "Material",
    unit: "SHEET",
    pack: null
  },
  {
    description: "M3 x 8 mm socket screw pack of 100",
    sku: "M3-8-100",
    type: "Consumable",
    unit: "PACK",
    pack: "100 screws per pack"
  },
  {
    description: "6 mm carbide end mill",
    sku: "EM-6-C",
    type: "Tool",
    unit: "EA",
    pack: null
  },
  {
    description: "Calibration service",
    sku: "CAL-STD",
    type: "Service",
    unit: "SERVICE",
    pack: null
  }
];

// Fixture prices use exact nonnegative integer cents, with half-up ratio rounding.
function cents(value: number) {
  const digits = String(value).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
function roundedRatio(numerator: number, denominator: number) {
  return Number(
    (BigInt(numerator) + BigInt(denominator) / BigInt(2)) / BigInt(denominator)
  );
}

/** Public labels are wholly synthetic; rendering artifacts belong in ignored storage. */
export function syntheticInvoiceFixtures(): InvoiceFixture[] {
  const fixtures: InvoiceFixture[] = [];
  for (let index = 0; index < 30; index++) {
    const number = index + 1,
      labels = emptyInvoiceExtraction();
    labels.documentKind =
      index === 26
        ? "credit"
        : index === 27
          ? "statement"
          : index === 28
            ? "paymentConfirmation"
            : index % 4 === 0
              ? "receipt"
              : "invoice";
    labels.supplier.name = evidence(`Example Supply ${(index % 3) + 1}`);
    labels.supplier.email = evidence(`receipts${(index % 3) + 1}@example.com`);
    labels.header.invoiceNumber = evidence(
      index === 8 ? null : `SYN-${String(number).padStart(3, "0")}`
    );
    labels.header.issueDate = evidence(
      `2026-08-${String(number).padStart(2, "0")}`
    );
    labels.header.currencyCode = evidence(index === 13 ? "EUR" : "USD");
    const lineCount = [6, 17, 23].includes(index) ? 12 : (index % 3) + 1;
    let subtotal = 0;
    for (let offset = 0; offset < lineCount; offset++) {
      const product = products[(index + offset) % products.length]!;
      const quantity = offset + 1 + (index >= 20 ? 1 : 0),
        price = 125 + 25 * offset + (index >= 20 ? 50 : 0);
      const amount = quantity * price;
      subtotal += amount;
      labels.lines.push({
        lineKey: `line-${offset + 1}`,
        page: offset < 6 ? 1 : 2,
        sourceText: null,
        description: evidence(product.description),
        supplierSku: evidence(product.sku),
        manufacturerPartNumber: evidence(null),
        quantity: evidence(String(quantity)),
        purchaseUnit: evidence(product.unit),
        packText: evidence(product.pack),
        unitPrice: evidence(cents(price)),
        discount: evidence("0.00"),
        tax: evidence("0.00"),
        taxPercent: evidence("0"),
        shipping: evidence("0.00"),
        lineTotal: evidence(cents(amount)),
        suggestedType: evidence(product.type)
      });
    }
    let tax = index === 10 ? roundedRatio(subtotal * 8, 100) : 0;
    const shipping = index === 11 ? 500 : 0,
      discount = index === 12 ? 100 : 0;
    if (index === 14) {
      tax = 0;
      for (const line of labels.lines) {
        const gross = Number(line.lineTotal.value!.replace(".", ""));
        const lineTax = gross - roundedRatio(gross * 100, 108);
        line.tax = evidence(cents(lineTax));
        line.taxPercent = evidence("0.08");
        tax += lineTax;
      }
      subtotal -= tax;
    }
    for (const [key, value] of Object.entries({
      subtotal,
      discount,
      shipping,
      tax,
      total: subtotal - discount + shipping + tax
    }))
      labels.header[
        key as "subtotal" | "discount" | "shipping" | "tax" | "total"
      ] = evidence(cents(value));
    const heading = [
      `${labels.documentKind.toUpperCase()} ${labels.header.invoiceNumber.value ?? "(no reference printed)"}`,
      labels.supplier.name.value!,
      labels.supplier.email.value!,
      `Date: ${labels.header.issueDate.value}`,
      `Currency: ${labels.header.currencyCode.value}`
    ];
    if (index === 10)
      heading.push("Prices exclude tax; invoice tax is listed below.");
    if (index === 14)
      heading.push(
        "Unit prices and line totals include 8% tax; subtotal excludes tax."
      );
    const rowTexts = labels.lines.flatMap((line) => [
      `${line.supplierSku.value} | ${line.description.value}`,
      `Qty ${line.quantity.value} ${line.purchaseUnit.value} | Unit ${line.unitPrice.value} | Line total ${line.lineTotal.value}`,
      `Discount ${line.discount.value}; tax ${line.tax.value}; shipping ${line.shipping.value}${line.packText.value ? `; ${line.packText.value}` : ""}`
    ]);
    const pages: string[][] = [];
    for (let start = 0; start < rowTexts.length; start += 18)
      pages.push([...heading, ...rowTexts.slice(start, start + 18)]);
    pages[pages.length - 1]!.push(
      `Subtotal ${labels.header.subtotal.value}`,
      `Discount ${labels.header.discount.value}`,
      `Shipping ${labels.header.shipping.value}`,
      `Tax ${labels.header.tax.value}`,
      `Total ${labels.header.total.value}`
    );
    if (index === 25) {
      labels.lines[0]!.description = evidence(
        "Bracket revision C (replacement for revision B)"
      );
      pages[0]![5] =
        "BRK-001-C | Bracket revision C (replacement for revision B)";
      labels.lines[0]!.supplierSku = evidence("BRK-001-C");
    }
    fixtures.push({
      id: `synthetic-${String(number).padStart(2, "0")}`,
      format: index % 5 === 0 ? "photo" : index % 3 === 0 ? "scan" : "pdf",
      pages,
      labels,
      heldOutRepeat: index >= 20 && index <= 24
    });
  }
  // Same bytes with a different upload name exercises hash-based deduplication.
  const original = fixtures[3]!;
  fixtures[29] = {
    ...structuredClone(original),
    id: "synthetic-30",
    duplicateOf: original.id,
    heldOutRepeat: false
  };
  return fixtures;
}
