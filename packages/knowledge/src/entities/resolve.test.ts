import { describe, expect, it } from "vitest";
import { resolveReceivedManual } from "./resolve";

const receipt = {
  id: "receipt-1",
  itemId: "motor-a",
  revision: "B",
  manufacturer: "Example Motors",
  mpn: "M-34-60",
  receivedAt: "2026-09-01T12:00:00Z",
  quantity: "2",
  reversedQuantity: "0",
  posted: true,
  voided: false
};
const link = {
  documentVersionId: "manual-b",
  itemId: "motor-a",
  revision: "B",
  manufacturer: "Example Motors",
  mpn: "M-34-60",
  verified: true
};
describe("receipt to applicable manual resolution", () => {
  it("uses positive posted receipts and an exact applicable item revision", () => {
    expect(resolveReceivedManual([receipt], [link])).toEqual({
      status: "resolved",
      itemId: "motor-a",
      documentVersionId: "manual-b",
      receiptId: "receipt-1"
    });
  });
  it("does not equate a frame or similar part number with exact identity", () => {
    expect(
      resolveReceivedManual([receipt], [{ ...link, mpn: "M3460" }]).status
    ).toBe("not-found");
    expect(
      resolveReceivedManual(
        [
          receipt,
          { ...receipt, id: "receipt-2", itemId: "motor-b", mpn: "M-34-80" }
        ],
        [link]
      ).status
    ).toBe("ambiguous");
  });
  it("excludes voids, reversals, unposted entries and old manual revisions", () => {
    for (const changed of [
      { voided: true },
      { posted: false },
      { reversedQuantity: "2" },
      { quantity: "0" }
    ])
      expect(
        resolveReceivedManual([{ ...receipt, ...changed }], [link]).status
      ).toBe("not-found");
    expect(
      resolveReceivedManual(
        [
          {
            ...receipt,
            manufacturer: "",
            missingIdentityFields: ["manufacturer"]
          }
        ],
        [{ ...link, manufacturer: "" }]
      ).status
    ).toBe("not-found");
    expect(
      resolveReceivedManual([receipt], [{ ...link, revision: "A" }]).status
    ).toBe("not-found");
  });
  it("does not choose between competing applicable manuals", () => {
    expect(
      resolveReceivedManual(
        [receipt],
        [link, { ...link, documentVersionId: "another-manual" }]
      ).status
    ).toBe("ambiguous");
  });
});
