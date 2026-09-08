import { describe, expect, it } from "vitest";
import { procurementDraftProposalSchema } from "./procurement";

const proposal = {
  id: "x",
  version: 1,
  action: "carbon.procurement.draft",
  idempotencyKey: "k",
  supplierId: "s",
  receivingLocationId: "l",
  businessTimezone: "America/New_York",
  lines: [
    {
      itemId: "i",
      itemRevisionId: "r",
      quantity: "1",
      purchaseUnitOfMeasureCode: "EA",
      inventoryUnitOfMeasureCode: "EA",
      conversionFactor: "1",
      supplierUnitPrice: "0"
    }
  ]
};

describe("procurement proposal", () => {
  it("requires positive bounded quantities and conversion factors", () => {
    expect(() =>
      procurementDraftProposalSchema.parse({
        ...proposal,
        lines: [{ ...proposal.lines[0], conversionFactor: "0" }]
      })
    ).toThrow();
    expect(() =>
      procurementDraftProposalSchema.parse({
        ...proposal,
        lines: [{ ...proposal.lines[0], quantity: "9".repeat(29) }]
      })
    ).toThrow();
  });

  it("rejects invalid calendar dates and IANA timezones", () => {
    expect(() =>
      procurementDraftProposalSchema.parse({
        ...proposal,
        requestedArrivalDate: "2026-02-31"
      })
    ).toThrow();
    expect(() =>
      procurementDraftProposalSchema.parse({
        ...proposal,
        businessTimezone: "Mars/Olympus_Mons"
      })
    ).toThrow();
  });

  it("allows a free supplier part and a scheduled execution timestamp", () => {
    expect(
      procurementDraftProposalSchema.parse({
        ...proposal,
        executeAt: "2026-09-08T12:00:00.000Z"
      }).lines[0]?.supplierUnitPrice
    ).toBe("0");
  });
});
