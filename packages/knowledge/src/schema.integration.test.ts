import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("private knowledge schema on disposable PostgreSQL", () => {
  it("enforces schema, ownership and role boundaries", () => {
    expect(() =>
      execFileSync(
        "python3",
        [
          resolve(import.meta.dirname, "../scripts/test_schema.py"),
          "SchemaTests"
        ],
        { stdio: "pipe" }
      )
    ).not.toThrow();
  });
});
