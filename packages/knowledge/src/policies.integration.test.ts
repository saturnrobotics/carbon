import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("private knowledge RLS on non-owner runtime roles", () => {
  it("enforces tenant, ACL intersection and transaction-local identity", () => {
    expect(() =>
      execFileSync(
        "python3",
        [
          resolve(import.meta.dirname, "../scripts/test_schema.py"),
          "PolicyTests"
        ],
        { stdio: "pipe" }
      )
    ).not.toThrow();
  });
});
