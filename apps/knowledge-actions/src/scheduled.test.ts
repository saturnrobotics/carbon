import { describe, expect, it } from "vitest";
import {
  assertNoDurableCredential,
  buildScheduledProcurementCommand
} from "./scheduled";

const proposal = {
  id: "procurement-proposal-1",
  version: 2,
  action: "carbon.procurement.draft",
  idempotencyKey: "procurement-idempotency-1",
  supplierId: "supplier-1",
  receivingLocationId: "location-1",
  requestedArrivalDate: "2026-10-15",
  proposedOrderByDate: "2026-09-30",
  businessTimezone: "America/New_York",
  lines: [
    {
      itemId: "PART-100",
      itemRevisionId: "item-revision-1",
      quantity: "2",
      purchaseUnitOfMeasureCode: "BOX",
      inventoryUnitOfMeasureCode: "EA",
      conversionFactor: "10"
    }
  ]
};

const now = "2026-09-08T12:00:00.000Z";

describe("buildScheduledProcurementCommand", () => {
  it("carries a command reference and its dates, never a credential", () => {
    const command = buildScheduledProcurementCommand(proposal, { now });
    expect(command).toEqual({
      idempotencyKey: "procurement-idempotency-1",
      payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      supplierId: "supplier-1",
      receivingLocationId: "location-1",
      requestedArrivalDate: "2026-10-15",
      proposedOrderByDate: "2026-09-30",
      executeAt: "2026-09-30T04:00:00.000Z",
      lines: proposal.lines
    });
  });

  it("hashes the business content only, so a deferred command replays equal", () => {
    const deferred = buildScheduledProcurementCommand(proposal, { now });
    const immediate = buildScheduledProcurementCommand(
      { ...proposal, executeAt: "2026-09-08T11:00:00.000Z" },
      { now }
    );
    expect(immediate.executeAt).toBeUndefined();
    expect(immediate.payloadHash).toBe(deferred.payloadHash);
  });

  it("prefers an explicit executeAt over the proposed order date", () => {
    expect(
      buildScheduledProcurementCommand(
        { ...proposal, executeAt: "2026-09-20T15:00:00.000Z" },
        { now }
      ).executeAt
    ).toBe("2026-09-20T15:00:00.000Z");
  });

  it("refuses an incomplete or inconsistent proposal", () => {
    const { supplierId: _supplier, ...noSupplier } = proposal;
    expect(() =>
      buildScheduledProcurementCommand(noSupplier, { now })
    ).toThrow();
    expect(() =>
      buildScheduledProcurementCommand(
        { ...proposal, requestedArrivalDate: "2026-09-01" },
        { now }
      )
    ).toThrow(/cannot precede/);
    expect(() =>
      buildScheduledProcurementCommand(
        { ...proposal, lines: [{ ...proposal.lines[0], quantity: "0" }] },
        { now }
      )
    ).toThrow();
  });
});

describe("assertNoDurableCredential", () => {
  it.each([
    "authorization",
    "token",
    "accessToken",
    "idToken",
    "assertion",
    "credential",
    "cookie",
    "actorId",
    "companyId"
  ])("refuses a command carrying %s", (field) => {
    expect(() =>
      assertNoDurableCredential({ idempotencyKey: "k", [field]: "value" })
    ).toThrow(/may not carry/);
  });

  it("accepts a plain command reference", () => {
    expect(() =>
      assertNoDurableCredential(
        buildScheduledProcurementCommand(proposal, { now })
      )
    ).not.toThrow();
  });
});
