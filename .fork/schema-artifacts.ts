import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import type { KyselyDatabase } from "../packages/database/src/client";
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  exportableColumns,
  getCompanyTableCatalog,
  selectExportableTables
} from "../packages/jobs/src/backups/schema";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)])
    );
  }
  return value;
}

export function canonicalTypes(source: string): string {
  const diagnostics = ts.transpileModule(source, {
    reportDiagnostics: true
  }).diagnostics;
  if (
    diagnostics?.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    )
  ) {
    throw new Error("Invalid generated TypeScript schema");
  }
  const parsed = ts.createSourceFile(
    "schema.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed
  });
  const transformed = ts.transform(parsed, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        const child = ts.visitEachChild(node, visit, context);
        if (
          ts.isPropertySignature(child) &&
          child.name &&
          child.type &&
          child.name.getText(parsed).replaceAll('"', "") === "Relationships" &&
          ts.isTupleTypeNode(child.type)
        ) {
          const members = [...child.type.elements].sort((a, b) =>
            printer
              .printNode(ts.EmitHint.Unspecified, a, parsed)
              .localeCompare(
                printer.printNode(ts.EmitHint.Unspecified, b, parsed)
              )
          );
          return ts.factory.updatePropertySignature(
            child,
            child.modifiers,
            child.name,
            child.questionToken,
            ts.factory.updateTupleTypeNode(child.type, members)
          );
        }
        if (ts.isObjectLiteralExpression(child)) {
          const properties = child.properties
            .map((property) => {
              if (
                !ts.isPropertyAssignment(property) ||
                !property.name ||
                !(
                  ts.isIdentifier(property.name) ||
                  ts.isStringLiteral(property.name) ||
                  ts.isNumericLiteral(property.name)
                )
              ) {
                throw new Error(
                  "Generated schema must contain literal object properties"
                );
              }
              return ts.factory.updatePropertyAssignment(
                property,
                ts.factory.createStringLiteral(property.name.text),
                property.initializer
              );
            })
            .sort((a, b) =>
              printer
                .printNode(ts.EmitHint.Unspecified, a.name, parsed)
                .localeCompare(
                  printer.printNode(ts.EmitHint.Unspecified, b.name, parsed)
                )
            );
          return ts.factory.createObjectLiteralExpression(properties, true);
        }
        return child;
      };
      return (node) => ts.visitNode(node, visit) as ts.SourceFile;
    }
  ]);
  try {
    const result = transformed.transformed[0];
    if (!result)
      throw new Error("TypeScript schema normalization produced no result");
    return printer.printFile(result);
  } finally {
    transformed.dispose();
  }
}

export function canonicalBackup(source: string): string {
  const manifest = JSON.parse(source);
  delete manifest.exportedAt;
  // Table/column enumeration order is not restore semantics.
  manifest.tables = manifest.tables
    .map((table: { name: string; columns: string[] }) => ({
      ...table,
      columns: [...table.columns].sort()
    }))
    .sort((a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name)
    );
  if (Array.isArray(manifest.excludedTables)) manifest.excludedTables.sort();
  return JSON.stringify(stable(manifest));
}

async function generateBackup(
  connectionFile: string,
  output: string
): Promise<void> {
  const connection = JSON.parse(readFileSync(connectionFile, "utf8"));
  const url = new URL(connection.url);
  if (
    !/^carbon-fork-schema-[a-z0-9-]+$/.test(connection.project) ||
    url.hostname !== "127.0.0.1" ||
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    (url.search && url.search !== "?sslmode=disable")
  ) {
    throw new Error("Invalid disposable schema connection descriptor");
  }
  const fromJobs = createRequire(
    new URL("../packages/jobs/package.json", import.meta.url)
  );
  const { Kysely, PostgresDialect, sql }: typeof import("kysely") =
    fromJobs("kysely");
  const pg: typeof import("pg") = fromJobs("pg");
  const db = new Kysely<KyselyDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: connection.url, max: 1 })
    })
  });
  try {
    const owner = await sql<{
      id: string;
    }>`SELECT id FROM fork_verification.owner`.execute(db);
    if (owner.rows.length !== 1 || owner.rows[0]?.id !== connection.project) {
      throw new Error(
        "Database ownership proof does not match this disposable run"
      );
    }
    const catalog = await getCompanyTableCatalog(db);
    if (catalog.schemaVersion === "unknown")
      throw new Error("Schema migration version unavailable");
    const { exportable, excludedTables } = selectExportableTables(catalog);
    const manifest = {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      schemaVersion: catalog.schemaVersion,
      sourceCompanyId: "schema-baseline",
      sourceCompanyGroupId: null,
      sourceCompanyName: null,
      exportedAt: "1970-01-01T00:00:00.000Z",
      exportedBy: "schema-baseline",
      label: "schema baseline",
      includeStorage: "none",
      tables: exportable.map((table) => ({
        name: table.name,
        rows: 0,
        columns: exportableColumns(table).map((column) => column.name)
      })),
      storage: [],
      excludedTables
    };
    writeFileSync(output, JSON.stringify(manifest));
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const [mode, kindOrConnection, path] = process.argv.slice(2);
  if (!kindOrConnection || !path)
    throw new Error("Missing schema artifact arguments");
  if (mode === "canonical") {
    if (!["types", "swagger", "backup"].includes(kindOrConnection))
      throw new Error("Unknown schema artifact kind");
    const source = readFileSync(path, "utf8");
    const canonical =
      kindOrConnection === "backup"
        ? canonicalBackup(source)
        : canonicalTypes(source);
    process.stdout.write(
      `${createHash("sha256").update(canonical).digest("hex")}\n`
    );
  } else if (mode === "backup") {
    await generateBackup(kindOrConnection, path);
  } else throw new Error("Unknown schema artifact operation");
}

if (require.main === module) {
  main().catch((error) => {
    const logDirectory = process.env.FORK_SCHEMA_LOG_DIR;
    if (logDirectory) {
      writeFileSync(
        join(logDirectory, "artifact-error.log"),
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      );
    }
    // Database drivers may include credentials in diagnostic text.
    process.stderr.write(
      "Schema artifact verification failed; no successful verdict was produced.\n"
    );
    process.exitCode = 1;
  });
}
