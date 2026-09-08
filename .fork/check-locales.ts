import { createRequire } from "node:module";
import { getCatalogs } from "@lingui/cli/api";

// Resolve the configuration loader from the pinned CLI's own dependencies.
const requireCli = createRequire(
  createRequire(import.meta.url).resolve("@lingui/cli")
);
const { getConfig } = requireCli("@lingui/conf") as {
  getConfig: (options: {
    configPath?: string;
  }) => Parameters<typeof getCatalogs>[0];
};

async function main() {
  if (process.argv.length > 3) {
    throw new Error("Usage: tsx .fork/check-locales.ts [lingui-config-path]");
  }
  const config = getConfig({ configPath: process.argv[2] });
  const catalogs = await getCatalogs(config);
  if (!catalogs.length || !config.locales.length) {
    throw new Error("Locale coverage requires configured catalogs and locales");
  }

  const problems: string[] = [];
  let sourceMessages = 0;
  for (const catalog of catalogs) {
    if (!catalog.sourcePaths.length) {
      throw new Error(`No source files found for catalog ${catalog.path}`);
    }
    // collect/readAll never write, merge, or remove authored catalog entries.
    const source = await catalog.collect();
    if (!source)
      throw new Error(`Extraction failed for catalog ${catalog.path}`);
    const translations = await catalog.readAll();
    const ids = Object.keys(source).sort();
    if (!ids.length) {
      throw new Error(
        `No source messages extracted for catalog ${catalog.path}`
      );
    }
    sourceMessages += ids.length;
    for (const locale of config.locales) {
      const filename = catalog.getFilename(locale);
      for (const id of ids) {
        const entry = translations[locale]?.[id];
        if (!entry) problems.push(`Missing source message: ${filename}: ${id}`);
        else if (entry.obsolete) {
          problems.push(`Obsolete source message: ${filename}: ${id}`);
        }
      }
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  process.stdout.write(
    `Checked ${sourceMessages} source messages across ${catalogs.length} catalogs and ${config.locales.length} locales\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Locale coverage failed"}\n`
  );
  process.exitCode = 1;
});
