import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./fusion";

describe("bounded hybrid rank fusion", () => {
  it("promotes agreement without counting repeated candidates in one source twice", () => {
    expect(
      reciprocalRankFusion(
        [
          [{ id: "exact" }, { id: "both" }, { id: "exact" }],
          [{ id: "semantic" }, { id: "both" }]
        ],
        2
      ).map((row) => row.id)
    ).toEqual(["both", "exact"]);
  });
  it("keeps ties deterministic and enforces evidence count", () => {
    expect(
      reciprocalRankFusion([[{ id: "b" }], [{ id: "a" }]], 1).map(
        (row) => row.id
      )
    ).toEqual(["a"]);
  });
  it("refuses unbounded fan-out and limits", () => {
    expect(() => reciprocalRankFusion([], 100)).toThrow();
    expect(() =>
      reciprocalRankFusion(
        Array.from({ length: 5 }, () => []),
        8
      )
    ).toThrow();
  });
});
