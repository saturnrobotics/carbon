import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findUntranslatedUi } from "./helpers/localization";

const root = join(process.cwd(), "app");

const files = [
  "modules/sales/ui/Customers/CustomersTable.tsx",
  "modules/sales/ui/Quotes/QuotesTable.tsx",
  "modules/sales/ui/SalesRFQ/SalesRFQsTable.tsx",
  "modules/sales/ui/SalesOrder/SalesOrdersTable.tsx",
  "modules/sales/ui/Customer/CustomerHeader.tsx",
  "modules/sales/ui/Quotes/QuoteHeader.tsx",
  "modules/sales/ui/SalesRFQ/SalesRFQHeader.tsx",
  "modules/sales/ui/SalesOrder/SalesOrderHeader.tsx",
  "modules/sales/ui/SalesOrder/SalesOrderSummary.tsx",
  "modules/invoicing/ui/SalesInvoice/SalesInvoicesTable.tsx",
  "modules/invoicing/ui/PurchaseInvoice/PurchaseInvoicesTable.tsx",
  "modules/invoicing/ui/PurchaseInvoice/PurchaseInvoiceHeader.tsx"
];

describe("localized sales and invoicing submodule UI", () => {
  test("avoids raw UI strings in localized table and header screens", () => {
    const offenders: string[] = [];

    for (const relativePath of files) {
      const source = readFileSync(join(root, relativePath), "utf8");
      offenders.push(
        ...findUntranslatedUi(source).map(
          (issue) => `${relativePath}: ${issue}`
        )
      );
    }

    expect(offenders).toEqual([]);
  });
});
