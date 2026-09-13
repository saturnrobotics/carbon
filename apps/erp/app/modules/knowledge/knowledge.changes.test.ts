import { describe, expect, it } from "vitest";
import { sourceChangesRequestValidator } from "./knowledge.changes.server";

describe("knowledge source-changes request bounds", () => {
  it("accepts the four bounded machine actions", () => {
    expect(
      sourceChangesRequestValidator.parse({
        action: "claim",
        sourceId: "ksrc_synthetic",
        workerId: "knowledge-worker-1",
        limit: 100
      }).action
    ).toBe("claim");
    expect(
      sourceChangesRequestValidator.parse({
        action: "acknowledge",
        sourceId: "ksrc_synthetic",
        workerId: "knowledge-worker-1",
        eventIds: ["kso_one", "kso_two"]
      }).action
    ).toBe("acknowledge");
    expect(
      sourceChangesRequestValidator.parse({
        action: "versions",
        sourceId: "ksrc_synthetic",
        entityType: "receipt",
        cursor: "rcv_last",
        limit: 100
      }).action
    ).toBe("versions");
    expect(
      sourceChangesRequestValidator.parse({
        action: "projections",
        sourceId: "ksrc_synthetic",
        entityType: "purchaseOrder",
        entityIds: ["po_one"]
      }).action
    ).toBe("projections");
  });

  it("rejects unbounded batches, unreviewed entity types and any company claim", () => {
    expect(() =>
      sourceChangesRequestValidator.parse({
        action: "claim",
        sourceId: "ksrc_synthetic",
        workerId: "w",
        limit: 101
      })
    ).toThrow();
    expect(() =>
      sourceChangesRequestValidator.parse({
        action: "versions",
        sourceId: "ksrc_synthetic",
        entityType: "itemCost",
        limit: 10
      })
    ).toThrow();
    expect(() =>
      sourceChangesRequestValidator.parse({
        action: "projections",
        sourceId: "ksrc_synthetic",
        entityType: "item",
        entityIds: Array.from({ length: 101 }, (_, index) => `item_${index}`)
      })
    ).toThrow();
    expect(() =>
      sourceChangesRequestValidator.parse({
        action: "claim",
        sourceId: "ksrc_synthetic",
        workerId: "w",
        limit: 10,
        companyId: "forged"
      })
    ).toThrow();
    expect(() =>
      sourceChangesRequestValidator.parse({
        action: "acknowledge",
        sourceId: "ksrc_synthetic",
        workerId: "w",
        eventIds: ["kso_one,deliveredAt.is.null"]
      })
    ).toThrow();
  });
});
