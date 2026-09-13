import { parseDate } from "@internationalized/date";
import { describe, expect, it } from "vitest";
import { receiptCalendarDate, resolveReceivedManual } from "./resolve";

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
      receiptId: "receipt-1",
      receivedOn: "2026-09-01"
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
  it("reads a posting date as a business calendar day, not a UTC instant", () => {
    // A Carbon posting date arrives as `YYYY-MM-DDT00:00:00Z`; it is the
    // company's calendar day and must not shift when the business timezone is
    // west of UTC.
    expect(
      receiptCalendarDate(
        "2026-09-01T00:00:00Z",
        "America/Los_Angeles"
      ).toString()
    ).toBe("2026-09-01");
    expect(
      receiptCalendarDate(
        "2026-09-01T03:30:00Z",
        "America/Los_Angeles"
      ).toString()
    ).toBe("2026-08-31");
  });
  it("counts the recent window in the business calendar and refuses future postings", () => {
    const asOf = parseDate("2026-09-10");
    const options = {
      businessTimezone: "America/Los_Angeles",
      recentDays: 30,
      asOf
    };
    expect(
      resolveReceivedManual(
        [{ ...receipt, receivedAt: "2026-08-12T00:00:00Z" }],
        [link],
        options
      ).status
    ).toBe("resolved");
    expect(
      resolveReceivedManual(
        [{ ...receipt, receivedAt: "2026-08-11T00:00:00Z" }],
        [link],
        options
      ).status
    ).toBe("not-found");
    expect(
      resolveReceivedManual(
        [{ ...receipt, receivedAt: "2026-09-11T00:00:00Z" }],
        [link],
        options
      ).status
    ).toBe("not-found");
  });
  it("grounds the answer on the most recent posting day when a reversal cleared the newer receipt", () => {
    const result = resolveReceivedManual(
      [
        { ...receipt, id: "older", receivedAt: "2026-08-20T00:00:00Z" },
        {
          ...receipt,
          id: "reversed",
          receivedAt: "2026-09-05T00:00:00Z",
          reversedQuantity: "2"
        }
      ],
      [link],
      { businessTimezone: "UTC", asOf: parseDate("2026-09-10") }
    );
    expect(result).toMatchObject({
      status: "resolved",
      receiptId: "older",
      receivedOn: "2026-08-20"
    });
  });
});
