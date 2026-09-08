import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("retention and recovery on disposable PostgreSQL", () => {
  it("honors holds, preserves tombstones and keeps runtime roles denied", () => {
    expect(() =>
      execFileSync(
        "python3",
        [resolve(import.meta.dirname, "../scripts/test_retention.py")],
        { stdio: "pipe" }
      )
    ).not.toThrow();
  });
});
