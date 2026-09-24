import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const command = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .scripts.postinstall;

function install(environment = {}, failFonts = false) {
  const directory = mkdtempSync(join(tmpdir(), "carbon-postinstall-"));
  try {
    const log = join(directory, "commands");
    writeFileSync(log, "");
    writeFileSync(
      join(directory, "pnpm"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$POSTINSTALL_TEST_LOG"\nif [ "$POSTINSTALL_TEST_FAIL" = "1" ] && [ "$1" = "--filter" ]; then exit 7; fi\n',
      { mode: 0o755 }
    );
    const result = spawnSync("sh", ["-c", command], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "",
        CARBON_CI_DEFER_GENERATION: "",
        ...environment,
        PATH: `${directory}:${process.env.PATH}`,
        POSTINSTALL_TEST_LOG: log,
        POSTINSTALL_TEST_FAIL: failFonts ? "1" : "0"
      }
    });
    return { status: result.status, commands: readFileSync(log, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("explicit CI deferral avoids the two root generators", () => {
  assert.deepEqual(install({ CI: "true", CARBON_CI_DEFER_GENERATION: "1" }), {
    status: 0,
    commands: ""
  });
});

test("ordinary installs still generate fonts then MCP", () => {
  assert.deepEqual(install(), {
    status: 0,
    commands: "--filter @carbon/documents build\nrun generate:mcp\n"
  });
});

test("CI alone and a deferral flag outside CI retain generation", () => {
  for (const environment of [
    { CI: "true" },
    { CARBON_CI_DEFER_GENERATION: "1" }
  ]) {
    assert.equal(
      install(environment).commands,
      "--filter @carbon/documents build\nrun generate:mcp\n"
    );
  }
});

test("a failed font build prevents MCP generation and fails installation", () => {
  assert.deepEqual(install({}, true), {
    status: 7,
    commands: "--filter @carbon/documents build\n"
  });
});
