<<<<<<< HEAD
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { generateDatabaseTypes } from "./lib/generate-db-types";
||||||| 85d9006e1
import {
  closeSync,
  copyFileSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as dotenv from "dotenv";
=======
import { generateDatabaseTypes } from "./lib/generate-db-types";
import { loadDotEnv } from "./lib/local-script-config";
>>>>>>> 5ba005208b53584224d846ef8544225fe3781191

try {
<<<<<<< HEAD
  for (const file of [".env", ".env.local"]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(
      parseEnv(readFileSync(file, "utf8"))
    )) {
      if (file === ".env.local" || process.env[key] === undefined)
        process.env[key] = value;
    }
  }
||||||| 85d9006e1
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error(
    "SUPABASE_DB_URL not set (expected in .env or .env.local). Run `pnpm dev:up` first."
  );
  process.exit(1);
}

if (!/(localhost|127\.0\.0\.1)/.test(dbUrl)) {
  console.error(
    `Refusing to generate types against non-local DB: ${dbUrl.replace(/:[^:@/]+@/, ":***@")}`
  );
  process.exit(1);
}

const typesPath = join("packages", "database", "src", "types.ts");
const fnTypesPath = join(
  "packages",
  "database",
  "supabase",
  "functions",
  "lib",
  "types.ts"
);

// Pipe supabase stdout directly to the types file to avoid spawnSync's 1MB
// default buffer cap (generated types are ~MBs).
const out = openSync(typesPath, "w");
const r = spawnSync(
  "supabase",
  [
    "gen",
    "types",
    "typescript",
    "--db-url",
    dbUrl,
    "--schema",
    "public",
    "--schema",
    "storage",
    "--schema",
    "graphql_public"
  ],
  { stdio: ["ignore", out, "inherit"] }
);
closeSync(out);

if (r.status !== 0) {
  console.error(`supabase gen types failed (exit ${r.status})`);
  process.exit(r.status ?? 1);
}

// Strip per-tenant `searchIndex_<companyId>` / `auditLog_<companyId>` tables.
// They are created at runtime per company (rebuild_search_index and the audit
// log setup in the migrations), so which ones exist depends on the local DB's
// seeded companies — committing them makes types.ts machine-dependent and
// churns on every regen. The static `searchIndexRegistry` / `auditLogArchive`
// tables (no underscore) are unaffected.
const stripPerTenantTables = (source: string): string => {
  const lines = source.split("\n");
  const result: string[] = [];
  let skipping = false;
  let stripped = 0;
  for (const line of lines) {
    if (
      !skipping &&
      /^      (searchIndex|auditLog)_[A-Za-z0-9]+: \{$/.test(line)
    ) {
      skipping = true;
      stripped++;
      continue;
    }
    if (skipping) {
      if (line === "      }") skipping = false;
      continue;
    }
    result.push(line);
  }
  if (stripped > 0) {
    console.log(`stripped ${stripped} per-tenant table(s)`);
  }
  return result.join("\n");
};

writeFileSync(typesPath, stripPerTenantTables(readFileSync(typesPath, "utf8")));

copyFileSync(typesPath, fnTypesPath);
console.log(`wrote ${typesPath}\nwrote ${fnTypesPath}`);
=======
  loadDotEnv();
>>>>>>> 5ba005208b53584224d846ef8544225fe3781191
  generateDatabaseTypes(process.env.SUPABASE_DB_URL);
  process.stdout.write("Database types refreshed in both output files.\n");
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Database type generation failed."}\n`
  );
  process.exitCode = 1;
}
