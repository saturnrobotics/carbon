import { describe, expect, it } from "vitest";
import { summarizeReceiptIdentities } from "./knowledge.receipts";

const line = {
  id: "line-one",
  itemId: "item-one",
  requiresBatchTracking: false,
  requiresSerialTracking: true,
  receipt: { id: "receipt-one", postingDate: "2026-09-01", status: "Posted" },
  item: { revision: "B", mpn: "SYN-100" }
};

describe("receipt identity projection", () => {
  it("aggregates reversals per tracked entity so a reversed serial cannot mask another", () => {
    const result = summarizeReceiptIdentities(
      [line],
      [
        { documentLineId: line.id, quantity: 2, trackedEntityId: "tracked-a" },
        { documentLineId: line.id, quantity: -2, trackedEntityId: "tracked-a" },
        { documentLineId: line.id, quantity: 1, trackedEntityId: "tracked-b" }
      ],
      [
        { id: "tracked-a", readableId: "SERIAL-A", attributes: {} },
        { id: "tracked-b", readableId: "SERIAL-B", attributes: {} }
      ]
    );

    expect(result.items).toMatchObject([
      { serial: "SERIAL-A", quantity: "2", reversedQuantity: "2" },
      { serial: "SERIAL-B", quantity: "1", reversedQuantity: "0" }
    ]);
  });

  it("uses the shared precision scale for ledger sums", () => {
    const result = summarizeReceiptIdentities(
      [{ ...line, requiresSerialTracking: false }],
      [
        { documentLineId: line.id, quantity: 0.1, trackedEntityId: null },
        { documentLineId: line.id, quantity: 0.2, trackedEntityId: null }
      ],
      []
    );

    expect(result.items[0]).toMatchObject({
      quantity: "0.3",
      reversedQuantity: "0"
    });
  });

  it("omits posted lines without ledger evidence and reports the result as partial", () => {
    const result = summarizeReceiptIdentities([line], [], []);

    expect(result.items).toEqual([]);
    expect(result.incompleteReasons).toContain("missing-ledger");
  });

  it("marks absent manufacturer and MPN as missing identity instead of complete identity", () => {
    const result = summarizeReceiptIdentities(
      [{ ...line, item: { revision: "B", mpn: null } }],
      [{ documentLineId: line.id, quantity: 1, trackedEntityId: "tracked-a" }],
      [{ id: "tracked-a", readableId: "SERIAL-A", attributes: {} }]
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
      [{ documentLineId: line.id, quantity: 1, trackedEntityId: null }],
      []
    );

    expect(result.items).toEqual([]);
    expect(result.incompleteReasons).toContain("invalid-posting-date");
  });
});
