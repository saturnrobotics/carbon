/**
 * Validate a trusted-caller registry file before release.
 *
 *   pnpm --filter @carbon/knowledge callers:validate <registry.json> [--schema <schema.json>]
 *
 * Prints each caller's subject, operations and audiences, exits 1 on any issue
 * and 2 on a usage error. Paths resolve from the directory pnpm was invoked in.
 * The checks themselves live in src/trusted-callers.ts.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TRUSTED_CALLERS_SCHEMA_PATH,
  validateCallerRegistry
} from "../src/trusted-callers";

const USAGE =
  "usage: callers:validate <registry.json> [--schema <callers.schema.json>]";

function inputPath(value: string): string {
  // pnpm runs package scripts from the package directory and records the
  // caller's directory in INIT_CWD, so repo-relative arguments resolve there.
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const remaining = [...argv];
  const files: string[] = [];
  let schemaPath = TRUSTED_CALLERS_SCHEMA_PATH;
  while (remaining.length > 0) {
    const argument = remaining.shift() as string;
    if (argument === "--schema") {
      const value = remaining.shift();
      if (!value) {
        fail(USAGE);
        return 2;
      }
      schemaPath = inputPath(value);
    } else {
      files.push(argument);
    }
  }
  const [registryFile] = files;
  if (files.length !== 1 || !registryFile) {
    fail(USAGE);
    return 2;
  }
  const registryPath = inputPath(registryFile);
  const document: unknown = JSON.parse(await readFile(registryPath, "utf8"));
  const schema: unknown = JSON.parse(await readFile(schemaPath, "utf8"));
  const report = validateCallerRegistry(document, schema);
  for (const line of report.summary) print(line);
  const failures = [
    ...report.runtimeIssues.map((issue) => `runtime schema: ${issue}`),
    ...report.schemaIssues.map((issue) => `callers.schema.json: ${issue}`),
    ...report.releaseIssues.map((issue) => `release rule: ${issue}`)
  ];
  if (failures.length > 0) {
    for (const failure of failures) fail(failure);
    fail(`${registryPath}: ${failures.length} issue(s)`);
    return 1;
  }
  print(
    `${registryPath}: conforms to the runtime schema, ${schemaPath} and the release rules`
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
