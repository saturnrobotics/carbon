import { procurementCommandPayloadHash } from "@carbon/knowledge/commands/procurement";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join("") })
}));
vi.mock("@carbon/glossary", () => ({
  terms: {},
  getEntry: vi.fn(),
  lookupEntry: vi.fn(),
  hasEntry: vi.fn(),
  termSlug: vi.fn()
}));

import {
  PROCUREMENT_COMMAND_ACTION,
  PROCUREMENT_COMMAND_VERSION,
  procurementDraftCommandValidator
} from "./knowledge.commands.server";

const lines = [
  {
    itemId: "PART-100",
    itemRevisionId: "item-revision-1",
    quantity: "2",
    purchaseUnitOfMeasureCode: "BOX",
    inventoryUnitOfMeasureCode: "EA",
    conversionFactor: "10",
    supplierUnitPrice: "1.25"
  }
];

const hash = (overrides: Record<string, unknown> = {}) =>
  procurementCommandPayloadHash({
    supplierId: "supplier-1",
    receivingLocationId: "location-1",
    proposedOrderByDate: "2026-09-30",
    lines,
    ...overrides
  });

const command = {
  idempotencyKey: "procurement-idempotency-1",
  payloadHash: hash(),
  supplierId: "supplier-1",
  receivingLocationId: "location-1",
  proposedOrderByDate: "2026-09-30",
  lines
};

describe("procurement command boundary", () => {
  it("names the action and payload version the schedule is written with", () => {
    expect(PROCUREMENT_COMMAND_ACTION).toBe("carbon.procurement.draft");
    expect(PROCUREMENT_COMMAND_VERSION).toBe(1);
  });

  it("accepts a hash-matched command and keeps decimals exact as strings", () => {
    const parsed = procurementDraftCommandValidator.parse(command);
    expect(parsed.lines[0]).toEqual({
      itemId: "PART-100",
      itemRevisionId: "item-revision-1",
      quantity: "2",
      purchaseUnitOfMeasureCode: "BOX",
      inventoryUnitOfMeasureCode: "EA",
      conversionFactor: "10",
      supplierUnitPrice: "1.25"
    });
  });

  it("keeps the three dates separate and only the arrival date optional-free", () => {
    const parsed = procurementDraftCommandValidator.parse({
      ...command,
      payloadHash: hash({ requestedArrivalDate: "2026-10-15" }),
      requestedArrivalDate: "2026-10-15",
      executeAt: "2026-09-30T04:00:00.000Z"
    });
    expect(parsed).toMatchObject({
      requestedArrivalDate: "2026-10-15",
      proposedOrderByDate: "2026-09-30",
      executeAt: "2026-09-30T04:00:00.000Z"
    });
  });

  it("refuses a payload whose hash does not cover it", () => {
    expect(() =>
      procurementDraftCommandValidator.parse({
        ...command,
        receivingLocationId: "location-2"
      })
    ).toThrow(/Payload hash does not match/);
    // A tampered LINE is caught by the same check, not only a header field.
    expect(() =>
      procurementDraftCommandValidator.parse({
        ...command,
        lines: [{ ...lines[0], quantity: "200" }]
      })
    ).toThrow(/Payload hash does not match/);
  });

  it("refuses arrival before the proposed order date", () => {
    expect(() =>
      procurementDraftCommandValidator.parse({
        ...command,
        payloadHash: hash({ requestedArrivalDate: "2026-09-01" }),
        requestedArrivalDate: "2026-09-01"
      })
    ).toThrow(/cannot precede/);
  });

  it.each([
    ["an impossible calendar date", { proposedOrderByDate: "2026-02-31" }],
    ["a non-numeric quantity", { lines: [{ ...lines[0], quantity: "many" }] }],
    [
      "an infinite quantity",
      { lines: [{ ...lines[0], quantity: "Infinity" }] }
    ],
    ["a zero quantity", { lines: [{ ...lines[0], quantity: "0" }] }],
    ["a negative quantity", { lines: [{ ...lines[0], quantity: "-2" }] }],
    [
      "an over-precise quantity",
      { lines: [{ ...lines[0], quantity: "2.000001" }] }
    ],
    [
      "a zero conversion factor",
      { lines: [{ ...lines[0], conversionFactor: "0" }] }
    ],
    ["a negative price", { lines: [{ ...lines[0], supplierUnitPrice: "-1" }] }],
    ["no lines", { lines: [] }],
    ["an unknown field", { approved: true }],
    ["a server-stamped actor", { actorId: "attacker" }],
    ["a server-stamped company", { companyId: "other-company" }],
    ["a malformed payload hash", { payloadHash: "not-a-hash" }]
  ])("rejects %s", (_label, override) => {
    expect(() =>
      procurementDraftCommandValidator.parse({ ...command, ...override })
    ).toThrow();
  });

  it("rejects a command with no proposal content at all", () => {
    expect(() => procurementDraftCommandValidator.parse({})).toThrow();
  });
});
