import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("additive schema compatibility", () => {
  it("preserves the original read projection while adding indexed evidence", () => {
    expect(() =>
      execFileSync(
        "python3",
        [
          resolve(import.meta.dirname, "../scripts/test_schema.py"),
          "PolicyTests.test_visible_manual_and_chunks_exclude_same_blob_with_other_acl",
          "PolicyTests.test_document_grant_supports_source_metadata_join_for_search"
        ],
        { stdio: "pipe" }
      )
    ).not.toThrow();
  });
});
