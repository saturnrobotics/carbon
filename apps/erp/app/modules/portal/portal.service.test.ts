import { describe, expect, it } from "vitest";
import { summarizeReceiptIdentities } from "./portal.receipts";

const line = {
  id: "line-one",
  itemId: "item-one",
  receivedQuantity: 1,
  requiresBatchTracking: false,
  requiresSerialTracking: true,
  receipt: { id: "receipt-one", postingDate: "2026-09-01", status: "Posted" },
  item: { revision: "B", mpn: "SYN-100" }
};

const entity = (id: string, readableId: string, index?: number) => ({
  id,
  readableId,
  attributes: {
    Receipt: "receipt-one",
    "Receipt Line": line.id,
    ...(index === undefined ? {} : { "Receipt Line Index": index })
  }
});

describe("receipt identity projection", () => {
  it("resolves a posted line with no ledger row at all", () => {
    // The regression this guards: `post-receipt` never records the receipt
    // line on its ledger rows, so a projection that needed one reported every
    // genuinely posted receipt as incomplete.
    const result = summarizeReceiptIdentities(
      [
        {
          ...line,
          receivedQuantity: 12,
          requiresSerialTracking: false,
          requiresBatchTracking: true
        }
      ],
      [entity("tracked-a", "LOT-A")]
    );

    expect(result.items).toMatchObject([
      { lot: "LOT-A", quantity: "12", reversedQuantity: "0", posted: true }
    ]);
    expect(result.incompleteReasons).toEqual(["missing-identity"]);
  });

  it("gives a serial-tracked line one row per serial, in receipt index order", () => {
    const result = summarizeReceiptIdentities(
      [{ ...line, receivedQuantity: 3 }],
      [
        entity("tracked-c", "SERIAL-C", 2),
        entity("tracked-a", "SERIAL-A", 0),
        entity("tracked-b", "SERIAL-B", 1)
      ]
    );

    expect(result.items.map((item) => item.serial)).toEqual([
      "SERIAL-A",
      "SERIAL-B",
      "SERIAL-C"
    ]);
    expect(result.items.every((item) => item.quantity === "1")).toBe(true);
  });

  it("keeps units without a serial visible rather than resolving as if identified", () => {
    const result = summarizeReceiptIdentities(
      [{ ...line, receivedQuantity: 3 }],
      [entity("tracked-a", "SERIAL-A", 0)]
    );

    expect(result.items).toMatchObject([
      { serial: "SERIAL-A", quantity: "1" },
      { quantity: "2", missingIdentityFields: ["manufacturer", "serial"] }
    ]);
    expect(result.incompleteReasons).toContain("missing-identity");
  });

  it("ignores a batch split child, which clones the parent's receipt line", () => {
    const parent = entity("tracked-a", "LOT-A");
    const result = summarizeReceiptIdentities(
      [
        {
          ...line,
          receivedQuantity: 12,
          requiresSerialTracking: false,
          requiresBatchTracking: true
        }
      ],
      [
        parent,
        {
          id: "tracked-child",
          readableId: "LOT-A",
          attributes: {
            ...parent.attributes,
            "Split From Entity ID": parent.id
          }
        }
      ]
    );

    expect(result.items).toMatchObject([{ lot: "LOT-A", quantity: "12" }]);
    expect(result.incompleteReasons).not.toContain("ambiguous-lot");
  });

  it("refuses to attribute a quantity when a batch line names two lots", () => {
    const result = summarizeReceiptIdentities(
      [
        {
          ...line,
          receivedQuantity: 12,
          requiresSerialTracking: false,
          requiresBatchTracking: true
        }
      ],
      [entity("tracked-a", "LOT-A"), entity("tracked-b", "LOT-B")]
    );

    expect(result.items).toEqual([]);
    expect(result.incompleteReasons).toContain("ambiguous-lot");
  });

  it("uses the shared precision scale for quantities", () => {
    const result = summarizeReceiptIdentities(
      [
        {
          ...line,
          receivedQuantity: 0.30000000000000004,
          requiresSerialTracking: false
        }
      ],
      []
    );

    expect(result.items[0]).toMatchObject({
      quantity: "0.3",
      reversedQuantity: "0"
    });
  });

  it("omits a line that received nothing without calling the read incomplete", () => {
    const result = summarizeReceiptIdentities(
      [{ ...line, receivedQuantity: 0 }],
      []
    );

    expect(result.items).toEqual([]);
    expect(result.incompleteReasons).toEqual([]);
  });

  it("marks absent manufacturer and MPN as missing identity instead of complete identity", () => {
    const result = summarizeReceiptIdentities(
      [{ ...line, item: { revision: "B", mpn: null } }],
      [entity("tracked-a", "SERIAL-A", 0)]
    );

    expect(result.items[0]).toMatchObject({
      manufacturer: "",
      mpn: "",
      missingIdentityFields: ["manufacturer", "mpn"]
    });
    expect(result.incompleteReasons).toContain("missing-identity");
  });

  it("validates receipt posting dates before producing timestamps", () => {
    const result = summarizeReceiptIdentities(
      [{ ...line, receipt: { ...line.receipt, postingDate: "not-a-date" } }],
      []
    );

    expect(result.items).toEqual([]);
    expect(result.incompleteReasons).toContain("invalid-posting-date");
  });
});
