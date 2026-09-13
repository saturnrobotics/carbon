import { parseDate } from "@internationalized/date";
import { describe, expect, it } from "vitest";
import {
  buildProcurementProposal,
  interpretProcurementRequest,
  procurementCommandPayloadHash,
  procurementDraftProposalSchema,
  resolveProcurementDate,
  resolveScheduledExecution,
  reviseProcurementProposal,
  toExecutableProcurementProposal
} from "./procurement";

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

// 2026-09-30 23:30 in New York is already 2026-10-01 in UTC.
const lateEvening = "2026-10-01T03:30:00.000Z";
const timezone = "America/New_York";

describe("executable procurement proposal", () => {
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

  it("keeps the three dates distinct and refuses arrival before ordering", () => {
    expect(
      procurementDraftProposalSchema.parse({
        ...proposal,
        requestedArrivalDate: "2026-10-15",
        proposedOrderByDate: "2026-09-30",
        executeAt: "2026-09-08T12:00:00.000Z"
      })
    ).toMatchObject({
      requestedArrivalDate: "2026-10-15",
      proposedOrderByDate: "2026-09-30",
      executeAt: "2026-09-08T12:00:00.000Z"
    });
    expect(() =>
      procurementDraftProposalSchema.parse({
        ...proposal,
        requestedArrivalDate: "2026-09-01",
        proposedOrderByDate: "2026-09-30"
      })
    ).toThrow(/cannot precede/);
  });
});

describe("canonical payload hash", () => {
  const payload = {
    supplierId: "s",
    receivingLocationId: "l",
    proposedOrderByDate: "2026-09-30",
    lines: proposal.lines
  };

  it("is independent of key order and of absent versus undefined fields", () => {
    const reordered = {
      lines: [
        {
          supplierUnitPrice: "0",
          conversionFactor: "1",
          inventoryUnitOfMeasureCode: "EA",
          purchaseUnitOfMeasureCode: "EA",
          quantity: "1",
          itemRevisionId: "r",
          itemId: "i"
        }
      ],
      proposedOrderByDate: "2026-09-30",
      requestedArrivalDate: undefined,
      receivingLocationId: "l",
      supplierId: "s"
    };
    expect(procurementCommandPayloadHash(reordered)).toBe(
      procurementCommandPayloadHash(payload)
    );
    expect(procurementCommandPayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with business content but not with scheduling metadata", () => {
    expect(
      procurementCommandPayloadHash({ ...payload, receivingLocationId: "l2" })
    ).not.toBe(procurementCommandPayloadHash(payload));
    expect(
      procurementCommandPayloadHash({
        ...payload,
        executeAt: "2026-09-30T04:00:00.000Z"
      } as typeof payload)
    ).toBe(procurementCommandPayloadHash(payload));
  });
});

describe("interpreting a request", () => {
  it("treats 60x20 as a dimension, never a quantity, and asks for the count", () => {
    const interpretation = interpretProcurementRequest(
      "Schedule purchase of 60x20 stators for month end",
      { businessTimezone: timezone, now: lateEvening }
    );
    expect(interpretation.itemDescriptor).toEqual({
      text: "stators",
      dimensions: ["60x20"]
    });
    expect(interpretation.quantity).toBeUndefined();
    expect(interpretation.clarifications.map((c) => c.field)).toEqual([
      "dateIntent",
      "quantity"
    ]);
  });

  it("leaves 'for month end' as an ambiguous date with both meanings offered", () => {
    const interpretation = interpretProcurementRequest(
      "Schedule purchase of 60x20 stators for month end",
      { businessTimezone: timezone, now: lateEvening }
    );
    // Late evening on 30 September in New York: the month has not ended.
    expect(interpretation.ambiguousDate).toBe("2026-09-30");
    expect(interpretation.requestedArrivalDate).toBeUndefined();
    expect(interpretation.proposedOrderByDate).toBeUndefined();
    expect(
      interpretation.clarifications.find((c) => c.field === "dateIntent")
    ).toMatchObject({
      choices: ["requestedArrivalDate", "proposedOrderByDate"]
    });
  });

  it("reads quantity, unit hint and cued dates from an explicit request", () => {
    const interpretation = interpretProcurementRequest(
      "order 40 boxes of M6x20 cap screws by end of month, needed by Oct 15",
      { businessTimezone: timezone, now: lateEvening }
    );
    expect(interpretation).toMatchObject({
      itemDescriptor: { text: "cap screws", dimensions: ["M6x20"] },
      quantity: "40",
      purchaseUnitHint: "boxes",
      proposedOrderByDate: "2026-09-30",
      requestedArrivalDate: "2026-10-15",
      clarifications: []
    });
  });

  it("asks which quantity when two counts compete", () => {
    const interpretation = interpretProcurementRequest(
      "buy 40 or 50 pcs of stators to arrive by tomorrow",
      { businessTimezone: timezone, now: lateEvening }
    );
    expect(interpretation.quantity).toBeUndefined();
    expect(
      interpretation.clarifications.find((c) => c.field === "quantity")
    ).toMatchObject({ choices: ["40", "50"] });
    expect(interpretation.requestedArrivalDate).toBe("2026-10-01");
  });

  it("asks for the item when nothing names one", () => {
    const interpretation = interpretProcurementRequest("order 5 pcs", {
      businessTimezone: timezone,
      now: lateEvening
    });
    expect(interpretation.clarifications.map((c) => c.field)).toEqual([
      "itemId"
    ]);
  });
});

describe("relative dates on the business calendar", () => {
  const anchor = parseDate("2026-09-30"); // a Wednesday

  it.each([
    ["today", "2026-09-30"],
    ["tomorrow", "2026-10-01"],
    ["month end", "2026-09-30"],
    ["end of next month", "2026-10-31"],
    ["end of week", "2026-10-04"],
    ["in 3 days", "2026-10-03"],
    ["in 2 weeks", "2026-10-14"],
    ["friday", "2026-10-02"],
    ["wednesday", "2026-10-07"],
    ["next friday", "2026-10-09"],
    ["Oct 15", "2026-10-15"],
    ["15 october", "2026-10-15"],
    ["Jan 5", "2027-01-05"],
    ["2026-12-01", "2026-12-01"]
  ])("resolves %s", (phrase, expected) => {
    expect(resolveProcurementDate(phrase, anchor)).toBe(expected);
  });

  it("returns nothing for an impossible or unknown phrase", () => {
    expect(resolveProcurementDate("2026-02-31", anchor)).toBeUndefined();
    expect(resolveProcurementDate("soonish", anchor)).toBeUndefined();
  });

  it("anchors 'tomorrow' on the business day, not the UTC day", () => {
    const interpretation = interpretProcurementRequest(
      "10 pcs of brackets needed by tomorrow",
      { businessTimezone: timezone, now: lateEvening }
    );
    expect(interpretation.requestedArrivalDate).toBe("2026-10-01");
    const utc = interpretProcurementRequest(
      "10 pcs of brackets needed by tomorrow",
      { businessTimezone: "UTC", now: lateEvening }
    );
    expect(utc.requestedArrivalDate).toBe("2026-10-02");
  });
});

describe("versioned proposal", () => {
  const base = {
    id: "proposal-1",
    idempotencyKey: "command-1",
    businessTimezone: timezone
  };

  it("keeps incomplete data as a proposal that names what is missing", () => {
    const draft = buildProcurementProposal({
      ...base,
      fields: { itemDescriptor: { text: "stators", dimensions: ["60x20"] } },
      ambiguousDate: "2026-09-30"
    });
    expect(draft.status).toBe("needs-clarification");
    expect(draft.version).toBe(1);
    expect(draft.ambiguousDate).toBe("2026-09-30");
    expect(draft.clarifications.map((c) => c.field)).toEqual([
      "itemId",
      "quantity",
      "purchaseUnitOfMeasureCode",
      "supplierId",
      "receivingLocationId",
      "dateIntent"
    ]);
    expect(() => toExecutableProcurementProposal(draft)).toThrow(
      /unresolved clarification/
    );
  });

  it("revises into new versions until ready, then yields one executable command", () => {
    const first = buildProcurementProposal({
      ...base,
      fields: { itemDescriptor: { text: "stators", dimensions: ["60x20"] } },
      ambiguousDate: "2026-09-30"
    });
    const second = reviseProcurementProposal(first, {
      itemId: "STATOR-60X20",
      itemRevisionId: "item-revision-b",
      quantity: "40",
      purchaseUnitOfMeasureCode: "BOX",
      inventoryUnitOfMeasureCode: "EA",
      conversionFactor: "10"
    });
    expect(second.version).toBe(2);
    expect(second.ambiguousDate).toBe("2026-09-30");
    expect(second.clarifications.map((c) => c.field)).toEqual([
      "supplierId",
      "receivingLocationId",
      "dateIntent"
    ]);
    const third = reviseProcurementProposal(second, {
      supplierId: "supplier-1",
      receivingLocationId: "location-1",
      dateIntent: "proposedOrderByDate"
    });
    expect(third).toMatchObject({
      version: 3,
      status: "ready",
      clarifications: [],
      fields: { proposedOrderByDate: "2026-09-30" }
    });
    expect(third.ambiguousDate).toBeUndefined();
    expect(toExecutableProcurementProposal(third)).toMatchObject({
      id: "proposal-1",
      version: 3,
      idempotencyKey: "command-1",
      supplierId: "supplier-1",
      receivingLocationId: "location-1",
      proposedOrderByDate: "2026-09-30",
      lines: [
        {
          itemId: "STATOR-60X20",
          itemRevisionId: "item-revision-b",
          quantity: "40",
          purchaseUnitOfMeasureCode: "BOX",
          inventoryUnitOfMeasureCode: "EA",
          conversionFactor: "10"
        }
      ]
    });
  });

  it("does not let arrival precede ordering", () => {
    const draft = buildProcurementProposal({
      ...base,
      fields: {
        itemId: "i",
        itemRevisionId: "r",
        quantity: "1",
        purchaseUnitOfMeasureCode: "EA",
        inventoryUnitOfMeasureCode: "EA",
        conversionFactor: "1",
        supplierId: "s",
        receivingLocationId: "l",
        requestedArrivalDate: "2026-09-01",
        proposedOrderByDate: "2026-09-30"
      }
    });
    expect(draft.status).toBe("needs-clarification");
    expect(draft.clarifications).toEqual([
      expect.objectContaining({
        field: "requestedArrivalDate",
        choices: ["2026-09-01", "2026-09-30"]
      })
    ]);
  });
});

describe("scheduled execution", () => {
  const now = "2026-09-08T12:00:00.000Z";

  it("runs immediately without a future moment", () => {
    expect(
      resolveScheduledExecution({ businessTimezone: timezone, now })
    ).toEqual({ mode: "immediate" });
    expect(
      resolveScheduledExecution({
        businessTimezone: timezone,
        now,
        proposedOrderByDate: "2026-09-08"
      })
    ).toEqual({ mode: "immediate" });
    expect(
      resolveScheduledExecution({
        businessTimezone: timezone,
        now,
        executeAt: "2026-09-08T11:59:59.000Z"
      })
    ).toEqual({ mode: "immediate" });
  });

  it("schedules a future order date at the start of that business day", () => {
    expect(
      resolveScheduledExecution({
        businessTimezone: timezone,
        now,
        proposedOrderByDate: "2026-09-30"
      })
    ).toEqual({ mode: "scheduled", executeAt: "2026-09-30T04:00:00.000Z" });
    expect(
      resolveScheduledExecution({
        businessTimezone: "Asia/Kolkata",
        now,
        proposedOrderByDate: "2026-09-30"
      })
    ).toEqual({ mode: "scheduled", executeAt: "2026-09-29T18:30:00.000Z" });
  });

  it("prefers an explicit future executeAt over the order date", () => {
    expect(
      resolveScheduledExecution({
        businessTimezone: timezone,
        now,
        proposedOrderByDate: "2026-09-30",
        executeAt: "2026-09-20T15:00:00.000Z"
      })
    ).toEqual({ mode: "scheduled", executeAt: "2026-09-20T15:00:00.000Z" });
  });
});
