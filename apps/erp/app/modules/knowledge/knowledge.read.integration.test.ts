import { describe, expect, it } from "vitest";
import {
  getDocumentReferencesValidator,
  getItemIdentityValidator,
  getPurchaseStatusValidator,
  getRecentReceiptItemsValidator,
  getRecentReceiptsValidator,
  resolveItemsValidator
} from "./knowledge.models";

describe("knowledge read request bounds", () => {
  it("accepts the reviewed bounded operation inputs", () => {
    expect(
      resolveItemsValidator.parse({ search: "SYN-100 / A", limit: 20 })
    ).toEqual({
      search: "SYN-100 / A",
      limit: 20
    });
    expect(getRecentReceiptsValidator.parse({ limit: 50 })).toEqual({
      limit: 50
    });
    expect(
      getRecentReceiptItemsValidator.parse({
        itemIds: ["item_one", "item_two"],
        limit: 20
      })
    ).toEqual({ itemIds: ["item_one", "item_two"], limit: 20 });
    expect(
      getItemIdentityValidator.parse({ itemId: "item_synthetic" })
    ).toBeTruthy();
    expect(
      getDocumentReferencesValidator.parse({ itemId: "item_synthetic" })
    ).toBeTruthy();
    expect(
      getPurchaseStatusValidator.parse({ purchaseOrderId: "PO-SYN-1" })
    ).toBeTruthy();
  });

  it("rejects unbounded or PostgREST-control input", () => {
    expect(() =>
      resolveItemsValidator.parse({ search: "x),companyId.neq.y", limit: 51 })
    ).toThrow();
    expect(() => getRecentReceiptsValidator.parse({ limit: 0 })).toThrow();
    expect(() =>
      getRecentReceiptItemsValidator.parse({
        itemIds: Array.from({ length: 51 }, (_, index) => `item_${index}`)
      })
    ).toThrow();
    expect(() =>
      getPurchaseStatusValidator.parse({
        purchaseOrderId: "PO-1,status.neq.Draft",
        actorId: "forged"
      })
    ).toThrow();
    expect(() =>
      getItemIdentityValidator.parse({
        itemId: "item_synthetic",
        companyId: "forged"
      })
    ).toThrow();
  });
});
