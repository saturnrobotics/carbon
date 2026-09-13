import { describe, expect, it } from "vitest";
import { INVALIDATION_EVENT_TYPES, planInvalidation } from "./epochs.server";

const delivered = [
  { sourceId: "source-b", eventType: "correction" },
  { sourceId: "source-a", eventType: "delete" },
  { sourceId: "source-a", eventType: "board-change" },
  { sourceId: "source-c", eventType: "index-version" },
  { sourceId: "source-b", eventType: "acl-change" }
];

describe("outbox invalidation planning", () => {
  it("collapses a batch to one bump per source and kind, revocations first", () => {
    expect(planInvalidation(delivered)).toEqual([
      { sourceId: "source-a", acl: true, content: true },
      { sourceId: "source-b", acl: true, content: true },
      { sourceId: "source-c", acl: false, content: true }
    ]);
  });
  it("yields the same plan for reordered and duplicated deliveries", () => {
    const expected = planInvalidation(delivered);
    expect(planInvalidation([...delivered].reverse())).toEqual(expected);
    expect(
      planInvalidation([...delivered, ...delivered, ...delivered])
    ).toEqual(expected);
    expect(
      planInvalidation([
        delivered[4]!,
        delivered[0]!,
        delivered[3]!,
        ...delivered
      ])
    ).toEqual(expected);
  });
  it("ignores indexing upserts and unknown kinds instead of guessing", () => {
    expect(
      planInvalidation([
        { sourceId: "source-a", eventType: "upsert" },
        { sourceId: "source-a", eventType: "reindex-everything" }
      ])
    ).toEqual([]);
    expect(INVALIDATION_EVENT_TYPES).not.toContain("upsert");
  });
});
