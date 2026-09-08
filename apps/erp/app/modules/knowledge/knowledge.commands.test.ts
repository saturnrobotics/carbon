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

import { procurementDraftCommandValidator } from "./knowledge.commands.server";

const command = {
  idempotencyKey: "procurement-idempotency-1",
  payloadHash: "a".repeat(64),
  supplierId: "supplier-1",
  receivingLocationId: "location-1",
  proposedOrderByDate: "2026-09-09",
  lines: [
    {
      itemId: "PART-100",
      itemRevisionId: "item-revision-1",
      quantity: "2",
      purchaseUnitOfMeasureCode: "BOX",
      inventoryUnitOfMeasureCode: "EA",
      conversionFactor: "10",
      supplierUnitPrice: "0"
    }
  ]
};

describe("procurement command boundary", () => {
  it("normalizes bounded decimal proposal fields only after validation", () => {
    const parsed = procurementDraftCommandValidator.parse(command);
    expect(parsed.lines[0]).toMatchObject({
      quantity: 2,
      conversionFactor: 10,
      supplierUnitPrice: 0
    });
  });

  it.each([
    ["impossible calendar date", { proposedOrderByDate: "2026-02-31" }],
    [
      "infinite quantity",
      { lines: [{ ...command.lines[0], quantity: "Infinity" }] }
    ],
    [
      "zero conversion",
      { lines: [{ ...command.lines[0], conversionFactor: "0" }] }
    ]
  ])("rejects %s", (_label, override) => {
    expect(() =>
      procurementDraftCommandValidator.parse({ ...command, ...override })
    ).toThrow();
  });
});
