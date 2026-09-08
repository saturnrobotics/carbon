import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(packageRoot, "src/check-datasets.ts");

function runCheck(databaseUrl: string | undefined, args: string[] = []) {
  const directory = mkdtempSync(path.join(tmpdir(), "carbon-dataset-check-"));
  const preload = path.join(directory, "pool.cjs");
  // Exercise the real CLI and verifier while preventing any database access.
  // Pool construction without config is always an error in this fixture.
  writeFileSync(
    preload,
    `require(${JSON.stringify(require.resolve("dotenv"))}).config = () => ({ parsed: {} });
const pg = require(${JSON.stringify(require.resolve("pg"))});
pg.Pool = class {
  constructor() {
    if (!process.env.SUPABASE_DB_URL?.trim()) throw new Error('Pool constructed without configuration');
  }
  on() {}
  async connect() {
    return {
      async query(sql) {
        if (sql === 'BEGIN') throw new Error('Synthetic dataset schema failure');
        if (sql.includes('FROM "user"')) return { rows: [{ id: 'system' }] };
        return { rows: [] };
      },
      release() {}
    };
  }
  async end() {}
};`
  );
  try {
    return spawnSync(
      process.execPath,
      [
        "--require",
        preload,
        "--import",
        require.resolve("tsx"),
        script,
        "--",
        ...args
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 10_000,
        // Dotenv is disabled in the child so real local credentials cannot
        // affect either absent-configuration or configured-database cases.
        env: { ...process.env, SUPABASE_DB_URL: databaseUrl }
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const databaseUrl of [undefined, "", "   "]) {
  test(`reports missing database configuration without constructing a pool (${databaseUrl === undefined ? "unset" : `${databaseUrl.length} characters`})`, () => {
    const result = runCheck(databaseUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dataset drift check skipped.*SUPABASE_DB_URL/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /includes|Pool constructed/
    );
  });
}

test("invalid dataset selection still blocks without a database", () => {
  const result = runCheck("", ["--dataset", "unknown-example"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No such dataset/);
  assert.doesNotMatch(result.stdout, /skipped/);
});

test("a configured database still runs verification and blocks on dataset failure", () => {
  const result = runCheck(
    "postgresql://example:synthetic@127.0.0.1:5432/example"
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Checking 4 dataset\(s\)/);
  assert.match(result.stderr, /Synthetic dataset schema failure/);
  assert.doesNotMatch(result.stdout, /skipped/);
});
