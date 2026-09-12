/**
 * Acceptance evaluator.
 *
 *   evaluate.ts suite=recall|interactive|performance|all [--output=<report.json>]
 *
 * `recall` and `interactive` run the A01–A15 cases in evaluations/acceptance.jsonl
 * with synthetic fixtures. `performance` runs the labelled 500-question fixture in
 * the disposable local PostgreSQL. Cases that need live cloud identity or a model
 * provider are reported as SKIPPED-NEEDS-CLOUD, never as passes; database-backed
 * cases are reported as SKIPPED-NEEDS-DISPOSABLE-DATABASE when the labelled
 * disposable database is not configured, and `all`/`performance` refuse to run
 * without it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { getDisposableLocalDatabaseUrl } from "../src/test/database";
import { type CheckContext, checks } from "./acceptance-checks";
import {
  administratorUrl,
  loadQuestions,
  type PerformanceReport,
  prepareReadPool,
  runPerformanceSuite
} from "./performance-fixture";

const suites = ["recall", "interactive", "performance", "all"] as const;
type Suite = (typeof suites)[number];
const caseSuites = ["recall", "interactive"] as const;
type CaseSuite = (typeof caseSuites)[number];
const criteria = Array.from(
  { length: 15 },
  (_, index) => `A${String(index + 1).padStart(2, "0")}`
);

type AcceptanceCase = {
  id: string;
  criterion: string;
  suite: CaseSuite;
  check: string;
  title: string;
  expected?: Record<string, unknown>;
  requiresCloud?: boolean;
  requiresDisposable?: boolean;
  requiresKanban?: boolean;
};
type CaseStatus =
  | "PASS"
  | "FAIL"
  | "SKIPPED-NEEDS-CLOUD"
  | "SKIPPED-NEEDS-DISPOSABLE-DATABASE"
  | "SKIPPED-NEEDS-KANBAN";
type CaseResult = AcceptanceCase & {
  status: CaseStatus;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
};

function parseSuite(): Suite {
  const value =
    process.argv
      .find((entry) => entry.startsWith("suite=") || entry.startsWith("--suite="))
      ?.replace(/^(?:--)?suite=/, "") ?? "all";
  if (!suites.includes(value as Suite))
    throw new Error(`suite must be one of ${suites.join("|")}`);
  return value as Suite;
}

function parseCases(text: string): AcceptanceCase[] {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AcceptanceCase);
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !/^A(0[1-9]|1[0-5])-[a-z0-9-]+$/.test(row.id) ||
      ids.has(row.id) ||
      row.id.slice(0, 3) !== row.criterion ||
      !caseSuites.includes(row.suite) ||
      !(row.check in checks) ||
      !row.title ||
      (row.expected !== undefined &&
        (typeof row.expected !== "object" || row.expected === null)) ||
      [row.requiresCloud, row.requiresDisposable, row.requiresKanban].some(
        (flag) => flag !== undefined && typeof flag !== "boolean"
      )
    )
      throw new Error(`Invalid acceptance case: ${JSON.stringify(row.id)}`);
    ids.add(row.id);
  }
  const covered = new Set(rows.map((row) => row.criterion));
  const missing = criteria.filter((criterion) => !covered.has(criterion));
  if (missing.length)
    throw new Error(`Acceptance matrix is incomplete: ${missing.join(", ")}`);
  const skippedOnly = criteria.filter((criterion) =>
    rows
      .filter((row) => row.criterion === criterion)
      .every((row) => row.requiresCloud || row.requiresKanban)
  );
  if (skippedOnly.some((criterion) => criterion !== "A01"))
    throw new Error(
      `Only A01 may depend entirely on live systems: ${skippedOnly.join(", ")}`
    );
  return rows;
}

async function runCase(
  row: AcceptanceCase,
  context: CheckContext | null
): Promise<CaseResult> {
  const started = performance.now();
  const finish = (
    status: CaseStatus,
    extra: Partial<CaseResult> = {}
  ): CaseResult => ({
    ...row,
    status,
    durationMs: Math.round(performance.now() - started),
    ...extra
  });
  if (row.requiresCloud) return finish("SKIPPED-NEEDS-CLOUD");
  if (row.requiresKanban) return finish("SKIPPED-NEEDS-KANBAN");
  if (row.requiresDisposable && !context?.database)
    return finish("SKIPPED-NEEDS-DISPOSABLE-DATABASE");
  try {
    const details = await checks[row.check]!({
      ...(row.requiresDisposable ? context : {}),
      expected: row.expected ?? {}
    });
    return finish("PASS", { details });
  } catch (error) {
    return finish("FAIL", {
      error: error instanceof Error ? error.message : "check failed"
    });
  }
}

async function main() {
  const suite = parseSuite();
  const cases = parseCases(
    await readFile(resolve(import.meta.dirname, "../evaluations/acceptance.jsonl"), "utf8")
  );
  const questionsPath = resolve(import.meta.dirname, "../evaluations/questions.jsonl");
  let databaseUrl: string | null = null;
  try {
    databaseUrl = getDisposableLocalDatabaseUrl();
  } catch (error) {
    if (suite === "all" || suite === "performance") throw error;
  }
  const pools = databaseUrl
    ? {
        readPool: await prepareReadPool(databaseUrl),
        adminPool: new pg.Pool({
          connectionString: administratorUrl(databaseUrl),
          max: 2,
          connectionTimeoutMillis: 5_000
        })
      }
    : null;
  let performanceReport: Promise<PerformanceReport> | undefined;
  const runPerformance = () => {
    if (!databaseUrl) throw new Error("performance suite requires the disposable database");
    performanceReport ??= loadQuestions(questionsPath).then((questions) =>
      runPerformanceSuite(databaseUrl, questions)
    );
    return performanceReport;
  };
  const context: CheckContext | null = pools
    ? { expected: {}, database: pools, performance: runPerformance }
    : null;
  const report: Record<string, unknown> = {
    schemaVersion: 2,
    suite,
    generatedAt: new Date().toISOString(),
    database: databaseUrl ? "disposable-local" : "none"
  };
  const results: CaseResult[] = [];
  try {
    for (const caseSuite of caseSuites) {
      if (suite !== "all" && suite !== caseSuite) continue;
      const rows: CaseResult[] = [];
      for (const row of cases.filter((entry) => entry.suite === caseSuite)) {
        const result = await runCase(row, context);
        rows.push(result);
        process.stderr.write(
          `${caseSuite} ${result.id} ${result.status}${result.error ? ` — ${result.error}` : ""}\n`
        );
      }
      report[caseSuite] = rows;
      results.push(...rows);
    }
    if (suite === "all" || suite === "performance")
      report.performance = await runPerformance();
  } finally {
    if (pools) await Promise.all([pools.readPool.end(), pools.adminPool.end()]);
  }
  const summary = {
    passed: results.filter((row) => row.status === "PASS").length,
    failed: results.filter((row) => row.status === "FAIL").length,
    skippedNeedsCloud: results.filter((row) => row.status === "SKIPPED-NEEDS-CLOUD").map((row) => row.id),
    skippedNeedsDisposableDatabase: results.filter((row) => row.status === "SKIPPED-NEEDS-DISPOSABLE-DATABASE").map((row) => row.id),
    skippedNeedsKanban: results.filter((row) => row.status === "SKIPPED-NEEDS-KANBAN").map((row) => row.id)
  };
  report.summary = summary;
  const output = process.argv.find((value) => value.startsWith("--output="));
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(resolve(process.cwd(), output.slice("--output=".length)), text);
  console.log(text);
  if (summary.failed > 0) {
    process.exitCode = 1;
    process.stderr.write(`${summary.failed} acceptance case(s) failed\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "evaluation failed");
  process.exitCode = 1;
});
