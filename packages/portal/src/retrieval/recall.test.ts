import { describe, expect, it } from "vitest";
import {
  compareExtensionVersions,
  supportsIterativeScan
} from "../schema-contract";
import { reciprocalRankFusion } from "./fusion";
import { RECALL_AT_10_THRESHOLD, recallAtK, selectVectorPath } from "./recall";

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

describe("filtered approximate recall against the exact baseline", () => {
  it("measures recall@k as the authorized exact set recovered, order-free", () => {
    expect(recallAtK(["a", "b", "c", "d"], ["d", "x", "a", "y"], 4)).toBe(0.5);
    expect(recallAtK(["a", "b"], ["b", "a", "c"], 2)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["a", "a", "a"], 3)).toBeCloseTo(1 / 3);
    expect(recallAtK([], ["a"], 10)).toBe(1);
    expect(() => recallAtK(["a"], ["a"], 0)).toThrow();
  });
  it("only trusts the index path with iterative scans, an index plan and calibrated recall", () => {
    const calibrated = {
      iterativeScan: true,
      ann: {
        recallAtK: RECALL_AT_10_THRESHOLD,
        path: "vector-ann" as const,
        usesIndex: true
      }
    };
    expect(selectVectorPath(calibrated)).toBe("ann");
    expect(
      selectVectorPath({
        ...calibrated,
        ann: { ...calibrated.ann, recallAtK: 0.9 }
      })
    ).toBe("exact");
    expect(selectVectorPath({ ...calibrated, iterativeScan: false })).toBe(
      "exact"
    );
    expect(
      selectVectorPath({
        ...calibrated,
        ann: { ...calibrated.ann, usesIndex: false }
      })
    ).toBe("exact");
  });
  it("gates iterative scans on the recorded pgvector version, numerically", () => {
    expect(supportsIterativeScan("0.8.0")).toBe(true);
    expect(supportsIterativeScan("0.10.1")).toBe(true);
    expect(supportsIterativeScan("0.7.4")).toBe(false);
    expect(compareExtensionVersions("0.8", "0.8.0")).toBe(0);
    expect(() => compareExtensionVersions("0.8.0-beta", "0.8.0")).toThrow();
  });
});
