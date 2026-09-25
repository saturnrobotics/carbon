<<<<<<< HEAD
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import {
  normalizeSwaggerSchema,
  PARTNER_ALIAS_PROOF_SQL
} from "./lib/swagger-schema";
||||||| 85d9006e1
import { writeFileSync } from "node:fs";
import * as dotenv from "dotenv";
=======
import { renameSync, writeFileSync } from "node:fs";
import { loadDotEnv } from "./lib/local-script-config";
import { normalizeSwaggerSchema } from "./lib/swagger-schema";
>>>>>>> 5ba005208b53584224d846ef8544225fe3781191

<<<<<<< HEAD
async function responseJson(
  response: Response,
  label: string
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

async function main(): Promise<void> {
  for (const file of [".env", ".env.local"]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(
      parseEnv(readFileSync(file, "utf8"))
    )) {
      if (file === ".env.local" || process.env[key] === undefined)
        process.env[key] = value;
    }
  }
  const studioPort = process.env.PORT_STUDIO;
  if (
    !studioPort ||
    !/^\d+$/.test(studioPort) ||
    Number(studioPort) < 1 ||
    Number(studioPort) > 65535
  )
    throw new Error(
      "PORT_STUDIO must identify a local Studio port; start the development stack first"
    );
  const studio = `http://127.0.0.1:${studioPort}`;
  const response = await fetch(
    `${studio}/api/platform/projects/default/api/rest`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!response.ok)
    throw new Error(`Swagger request failed (HTTP ${response.status})`);
  const raw = await responseJson(response, "Swagger");
  const proofResponse = await fetch(
    `${studio}/api/platform/pg-meta/default/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: PARTNER_ALIAS_PROOF_SQL }),
      signal: AbortSignal.timeout(30_000)
    }
  );
  if (!proofResponse.ok)
    throw new Error(
      `Schema proof request failed (HTTP ${proofResponse.status})`
    );
  const data = normalizeSwaggerSchema(
    raw,
    await responseJson(proofResponse, "Schema proof")
  );
||||||| 85d9006e1
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

const studioPort = process.env.PORT_STUDIO;
if (!studioPort) {
  console.error(
    "PORT_STUDIO not set (expected in .env.local). Run `pnpm dev:up` first."
  );
  process.exit(1);
}

const url = `http://localhost:${studioPort}/api/platform/projects/default/api/rest`;

(async () => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
=======
async function main(): Promise<void> {
  loadDotEnv();
  const studioPort = process.env.PORT_STUDIO;
  if (!studioPort)
    throw new Error(
      "PORT_STUDIO not set (expected in .env.local). Run `pnpm dev:up` first."
    );
  const response = await fetch(
    `http://127.0.0.1:${studioPort}/api/platform/projects/default/api/rest`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!response.ok)
    throw new Error(`Swagger request failed (HTTP ${response.status})`);
  const data = normalizeSwaggerSchema(await response.json());
>>>>>>> 5ba005208b53584224d846ef8544225fe3781191

  // Strip per-tenant `searchIndex_<companyId>` / `auditLog_<companyId>` tables
  // (created at runtime per company) — which ones exist depends on the local
  // DB's seeded companies, so committing them makes the schema
  // machine-dependent. Their keys appear as "/<table>" paths, "<table>"
  // definitions, and "rowFilter.<table>.<col>" parameters. The static
  // "searchIndexRegistry" / "auditLogArchive" tables (no underscore) are
  // unaffected.
  const stripPerTenantKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripPerTenantKeys);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !/(searchIndex|auditLog)_[A-Za-z0-9]/.test(key))
          .map(([key, v]) => [key, stripPerTenantKeys(v)])
      );
    }
    return value;
  };

  const output = "packages/database/src/swagger-docs-schema.ts";
<<<<<<< HEAD
  const temporary = mkdtempSync(join(dirname(output), ".swagger-generation-"));
  try {
    const candidate = join(temporary, "schema.ts");
    writeFileSync(
      candidate,
      `export default ${JSON.stringify(stripPerTenantKeys(data), null, 2)}`
    );
    renameSync(candidate, output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  process.stdout.write(
    "Swagger schema refreshed with verified partner alias metadata.\n"
||||||| 85d9006e1
  writeFileSync(
    "packages/database/src/swagger-docs-schema.ts",
    `export default ${JSON.stringify(stripPerTenantKeys(data), null, 2)}`
=======
  writeFileSync(
    `${output}.tmp`,
    `export default ${JSON.stringify(stripPerTenantKeys(data), null, 2)}`
>>>>>>> 5ba005208b53584224d846ef8544225fe3781191
  );
<<<<<<< HEAD
}

main().catch((error) => {
  process.stderr.write(
    `Swagger generation failed: ${error instanceof Error ? error.message : "verification did not complete"}\n`
||||||| 85d9006e1
})();
=======
  renameSync(`${output}.tmp`, output);
  process.stdout.write("Swagger schema refreshed.\n");
}

main().catch((error) => {
  process.stderr.write(
    `Swagger generation failed: ${error instanceof Error ? error.message : String(error)}\n`
>>>>>>> 5ba005208b53584224d846ef8544225fe3781191
  );
  process.exitCode = 1;
});
