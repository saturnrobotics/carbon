// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

/**
 * MCP Tool Metadata Generator
 *
 * Writes tool-metadata.json from the service functions the ERP router
 * publishes (`scripts/lib/service-fn-metadata.ts`).
 *
 * Usage: npx tsx scripts/generate-mcp.ts
 */

import * as fs from "fs";
import { getDbTablesWithColumn } from "./lib/db-types";
import * as path from "path";

import {
  buildManifestDigest,
  serializeManifestDigest
} from "./lib/manifest-digest";
<<<<<<< HEAD
import {
  buildAllToolMetadataWithValidators,
  MODULE_LIST
} from "./lib/service-metadata";

const log = (message: string) => process.stdout.write(`${message}\n`);
const warn = (message: string) => process.stderr.write(`${message}\n`);
||||||| 85d9006e1
import { buildAllToolMetadataWithValidators } from "./lib/service-metadata";
=======
import { buildManifest } from "./lib/service-fn-metadata";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

const ROOT = path.resolve(__dirname, "..");
const METADATA_FILE = path.join(
  ROOT,
  "apps/erp/app/routes/api+/mcp+/lib/tool-metadata.json"
);
/**
 * Committed companion to the (gitignored) manifest — see `lib/manifest-digest.ts`.
 * Small enough to read in a diff, so a schema regression is still visible in review.
 */
export const DIGEST_FILE = path.join(
  ROOT,
  "apps/erp/app/routes/api+/mcp+/lib/tool-manifest.digest.json"
);

export async function generateToolMetadata(): Promise<void> {
<<<<<<< HEAD
  log("Generating tool metadata from service files...");
||||||| 85d9006e1
  console.log("Generating tool metadata from service files...");
=======
  console.log("Generating tool metadata from the service functions...");
  const tools = buildManifest();
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

<<<<<<< HEAD
  const {
    tools: allTools,
    registryStats,
    responseStats,
    resolutions
  } = await buildAllToolMetadataWithValidators({
    onModule: (mod, count) => log(`  ✓ ${mod}: ${count} tools`)
  });
||||||| 85d9006e1
  const { tools: allTools, registryStats, responseStats, resolutions } =
    await buildAllToolMetadataWithValidators({
      onModule: (mod, count) => console.log(`  ✓ ${mod}: ${count} tools`),
    });
=======
  // The tables a tenant's rows live in. Every update and delete an API caller
  // makes on one of them is filtered by the caller's company
  // (`scopedToCompany`), so a list that came back empty would switch that off
  // without a sound.
  const companyTables = getDbTablesWithColumn("companyId");
  if (!companyTables.includes("customer") || companyTables.length < 100) {
    throw new Error(
      `generate:mcp found only ${companyTables.length} tables with a companyId column in the generated database types; the company filter depends on that list. Nothing was written.`
    );
  }
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

  // No timestamp: the file must be a pure function of the sources so repeated
  // runs on an unchanged tree are byte-identical. Minified: this file is
  // gitignored build output that only machines read; the readable artifact is
  // the digest.
  const metadata = {
<<<<<<< HEAD
    totalTools: allTools.length,
    modules: [...new Set(allTools.map((t) => t.module))].length,
    tools: allTools
||||||| 85d9006e1
    generated: new Date().toISOString(),
    totalTools: allTools.length,
    modules: [...new Set(allTools.map((t) => t.module))].length,
    tools: allTools,
=======
    totalTools: tools.length,
    modules: [...new Set(tools.map((t) => t.module))].length,
    companyTables,
    tools
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
  };
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata));
<<<<<<< HEAD
  fs.writeFileSync(
    DIGEST_FILE,
    serializeManifestDigest(buildManifestDigest(allTools))
  );
  log(`\n✓ Generated metadata for ${allTools.length} tools`);
  log(`  Output: ${path.relative(ROOT, METADATA_FILE)} (gitignored)`);
  log(`  Digest: ${path.relative(ROOT, DIGEST_FILE)} (committed)`);

  // Schema provenance. A validator that fell back to source-text parsing still
  // produces a manifest entry, so surface it rather than letting the degrade pass
  // silently — that fallback is the only path that can publish a lossy schema.
  const fallbacks = resolutions.filter((r) => r.how !== "native");
  log(
    `  Schemas: ${registryStats.validatorsConverted} validators converted from ${registryStats.modulesLoaded}/${MODULE_LIST.length} modules`
  );
  log(
    `  Responses: ${responseStats.derived}/${responseStats.functions} reflected from return types (${responseStats.empty} yielded nothing usable)`
  );
  if (registryStats.moduleErrors.length > 0) {
    warn(`  ⚠ ${registryStats.moduleErrors.length} module(s) failed to load:`);
    for (const e of registryStats.moduleErrors) {
      warn(`      ${e.module}: ${e.error}`);
    }
  }
  if (registryStats.conversionFailures.length > 0) {
    warn(
      `  ⚠ ${registryStats.conversionFailures.length} validator(s) failed to convert:`
    );
    for (const f of registryStats.conversionFailures.slice(0, 10)) {
      warn(`      ${f.module}.${f.name}: ${f.error}`);
    }
  }
  if (fallbacks.length > 0) {
    const unique = [...new Set(fallbacks.map((f) => f.validatorName))];
    warn(
      `  ⚠ ${fallbacks.length} param(s) used the source-text fallback: ${unique.slice(0, 12).join(", ")}`
    );
  }
||||||| 85d9006e1
  fs.writeFileSync(
    DIGEST_FILE,
    serializeManifestDigest(buildManifestDigest(allTools))
  );
  console.log(`\n✓ Generated metadata for ${allTools.length} tools`);
  console.log(`  Output: ${path.relative(ROOT, METADATA_FILE)} (gitignored)`);
  console.log(`  Digest: ${path.relative(ROOT, DIGEST_FILE)} (committed)`);

  // Schema provenance. A validator that fell back to source-text parsing still
  // produces a manifest entry, so surface it rather than letting the degrade pass
  // silently — that fallback is the only path that can publish a lossy schema.
  const fallbacks = resolutions.filter((r) => r.how !== "native");
  console.log(
    `  Schemas: ${registryStats.validatorsConverted} validators converted from ${registryStats.modulesLoaded}/15 modules`
  );
  console.log(
    `  Responses: ${responseStats.derived}/${responseStats.functions} reflected from return types (${responseStats.empty} yielded nothing usable)`
  );
  if (registryStats.moduleErrors.length > 0) {
    console.warn(`  ⚠ ${registryStats.moduleErrors.length} module(s) failed to load:`);
    for (const e of registryStats.moduleErrors) {
      console.warn(`      ${e.module}: ${e.error}`);
    }
  }
  if (registryStats.conversionFailures.length > 0) {
    console.warn(
      `  ⚠ ${registryStats.conversionFailures.length} validator(s) failed to convert:`
    );
    for (const f of registryStats.conversionFailures.slice(0, 10)) {
      console.warn(`      ${f.module}.${f.name}: ${f.error}`);
    }
  }
  if (fallbacks.length > 0) {
    const unique = [...new Set(fallbacks.map((f) => f.validatorName))];
    console.warn(
      `  ⚠ ${fallbacks.length} param(s) used the source-text fallback: ${unique.slice(0, 12).join(", ")}`
    );
  }
=======
  fs.writeFileSync(DIGEST_FILE, serializeManifestDigest(buildManifestDigest(tools)));
  console.log(`✓ Generated metadata for ${tools.length} tools across ${metadata.modules} modules`);
  console.log(`  Output: ${path.relative(ROOT, METADATA_FILE)} (gitignored)`);
  console.log(`  Digest: ${path.relative(ROOT, DIGEST_FILE)} (committed)`);
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
}

if (require.main === module) {
  generateToolMetadata().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
