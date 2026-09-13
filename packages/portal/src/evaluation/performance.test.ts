import { describe, expect, it } from "vitest";
import { summarizeMeasurements } from "./performance";

describe("performance evaluation summaries", () => {
  it("reports percentile, error, and recall measurements without hiding failures", () => {
    expect(
      summarizeMeasurements([
        { durationMs: 1, ok: true, recalled: true },
        { durationMs: 2, ok: true, recalled: false },
        { durationMs: 100, ok: false, recalled: false }
      ])
    ).toEqual({
      count: 3,
      errors: 1,
      errorRate: 1 / 3,
      recallAt10: 0.5,
      p50Ms: 2,
      p95Ms: 100,
      p99Ms: 100
    });
  });
});
