import { describe, expect, it } from "vitest";
import {
  type InvoiceRecognitionLine,
  invoiceItemMatchKey,
  invoiceRecognitionSource,
  normalizeInvoiceIdentity,
  prepareInvoiceRecognitionDecisions,
  recognizeInvoiceLine
} from "./recognition";

const line: InvoiceRecognitionLine = {
  lineKey: "1",
  description: "M4 x 10 — Grade 8.8",
  supplierSku: "0004_%",
  manufacturerPartNumber: null,
  purchaseUnit: "BAG"
};
const item = {
  id: "item-1",
  name: "M4 fasteners",
  readableId: "FAST-0004",
  type: "Consumable" as const,
  active: true,
  unitOfMeasureCode: "EA"
};
const part = {
  id: "sp-1",
  itemId: item.id,
  supplierPartId: "0004_%",
  supplierUnitOfMeasureCode: "BAG",
  conversionFactor: 100,
  active: true
};
describe("invoice recognition", () => {
  it("rejects conflicting remembered targets for one source identity instead of keeping the last row", () => {
    const first = {
      ...line,
      itemId: item.id,
      purchaseUnit: "BAG",
      stockUnit: "EA",
      conversionFactor: 100,
      remember: true
    };
    expect(() =>
      prepareInvoiceRecognitionDecisions([
        first,
        { ...first, lineKey: "2", itemId: "other-item" }
      ])
    ).toThrow("conflicting remembered matches");
    expect(() =>
      prepareInvoiceRecognitionDecisions([
        first,
        { ...first, lineKey: "2", conversionFactor: 200 }
      ])
    ).toThrow("conflicting remembered matches");
    expect(
      prepareInvoiceRecognitionDecisions([first, { ...first, lineKey: "2" }])
    ).toHaveLength(1);
    expect(
      prepareInvoiceRecognitionDecisions([
        first,
        { ...first, itemId: "exception", remember: false }
      ])
    ).toHaveLength(1);
  });
  it("learns the original document identity when the reviewer changes its label and unit spelling", () => {
    const source = invoiceRecognitionSource({
      ...line,
      itemId: item.id,
      purchaseUnit: "BG",
      stockUnit: "EA",
      conversionFactor: 100,
      remember: true,
      description: "Internal fastener name",
      rawDescription: line.description,
      rawPurchaseUnit: "BAG"
    });
    expect(invoiceItemMatchKey(source)).toBe(invoiceItemMatchKey(line));
  });
  it("remembers literal supplier SKU and unit without any financial defaults", () => {
    expect(
      recognizeInvoiceLine(line, {
        rules: [],
        supplierParts: [part],
        items: [item]
      })
    ).toMatchObject({
      status: "matched",
      itemId: item.id,
      itemType: "Consumable",
      conversionFactor: 100
    });
  });
  it("never treats SQL wildcard characters as pattern syntax", () => {
    const result = recognizeInvoiceLine(
      { ...line, supplierSku: "0004-123" },
      { rules: [], supplierParts: [part], items: [item] }
    );
    expect(result.itemId).toBeNull();
  });
  it("leaves a changed purchasing unit or new pack description for review", () => {
    for (const changed of [
      { ...line, purchaseUnit: "EA" },
      { ...line, packText: "200 per bag" }
    ]) {
      expect(
        recognizeInvoiceLine(changed, {
          rules: [],
          supplierParts: [part],
          items: [item]
        }).status
      ).not.toBe("matched");
    }
  });
  it("refuses duplicate SKU identities and stale inventory units", () => {
    expect(
      recognizeInvoiceLine(line, {
        rules: [],
        supplierParts: [part, { ...part, id: "other", conversionFactor: 200 }],
        items: [item]
      }).status
    ).toBe("conflict");
    const rule = {
      id: "rule-1",
      matchKey: invoiceItemMatchKey(line),
      itemId: item.id,
      supplierPartId: part.id,
      purchaseUnit: "BAG",
      stockUnit: "KG",
      conversionFactor: 100
    };
    expect(
      recognizeInvoiceLine(line, {
        rules: [rule],
        supplierParts: [part],
        items: [item]
      }).status
    ).toBe("conflict");
  });
  it("keeps grades, dimensions, revisions and leading zeros distinct", () => {
    expect(normalizeInvoiceIdentity("  M4   x 10 ")).toBe("m4 x 10");
    for (const description of [
      "M4 x 10 — Grade 10.9",
      "M4 x 12 — Grade 8.8",
      `${line.description} Rev B`
    ])
      expect(invoiceItemMatchKey({ ...line, description })).not.toBe(
        invoiceItemMatchKey(line)
      );
    expect(normalizeInvoiceIdentity("0004")).not.toBe(
      normalizeInvoiceIdentity("4")
    );
  });
  it("uses confirmed pack-specific correction on the next receipt", () => {
    const packed = { ...line, packText: "100 per bag" };
    const rule = {
      id: "rule-1",
      matchKey: invoiceItemMatchKey(packed),
      itemId: item.id,
      supplierPartId: part.id,
      purchaseUnit: "BAG",
      stockUnit: "EA",
      conversionFactor: 100
    };
    expect(
      recognizeInvoiceLine(packed, {
        rules: [rule],
        supplierParts: [part],
        items: [item]
      })
    ).toMatchObject({ status: "matched", ruleId: rule.id });
    expect(
      recognizeInvoiceLine(
        { ...packed, packText: "200 per bag" },
        { rules: [rule], supplierParts: [part], items: [item] }
      ).status
    ).not.toBe("matched");
  });
});
