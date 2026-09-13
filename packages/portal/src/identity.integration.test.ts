import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("source-owned workforce identity resolver", () => {
  it("bypasses private RLS only for trusted runtime roles", () => {
    expect(() =>
      execFileSync(
        "python3",
        [
          resolve(import.meta.dirname, "../scripts/test_schema.py"),
          "IdentityResolverTests"
        ],
        { stdio: "pipe" }
      )
    ).not.toThrow();
  });
});
