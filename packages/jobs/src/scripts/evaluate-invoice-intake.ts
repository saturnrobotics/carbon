/** Offline scoring only. Live samples must use the deployed, budgeted intake worker. */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evaluateInvoices } from "../invoice-intake/evaluation";
import { syntheticInvoiceFixtures } from "../invoice-intake/fixtures/synthetic";

async function privateDirectory(raw: string | undefined) {
  if (!raw)
    throw new Error("Set the private evaluation input/output directories");
  const directory = path.resolve(raw);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory);
  const git = spawnSync("git", ["check-ignore", "--quiet", canonical], {
    stdio: "ignore"
  });
  if (git.status !== 0)
    throw new Error("Evaluation directories must be ignored by Git");
  return canonical;
}
const sampleSchema = z
  .object({
    fixtureId: z.string(),
    modelId: z.string(),
    attemptId: z.string(),
    result: z.unknown(),
    status: z.string(),
    latencyMs: z.number().finite().nonnegative(),
    actualCostUsd: z.number().finite().nonnegative().nullable(),
    correctedFields: z.number().int().nonnegative().optional(),
    reviewedFields: z.number().int().nonnegative().optional(),
    repeatSelection: z
      .object({ expected: z.unknown(), actual: z.unknown() })
      .optional()
  })
  .strict();
async function main() {
  const output = await privateDirectory(process.env.INVOICE_EVAL_OUTPUT_DIR);
  const fixtures = syntheticInvoiceFixtures();
  if (process.argv.includes("--generate")) {
    await writeFile(
      path.join(output, "fixtures.json"),
      JSON.stringify(fixtures, null, 2),
      { mode: 0o600 }
    );
    const renderer = fileURLToPath(
      new URL("../invoice-intake/fixtures/render.py", import.meta.url)
    );
    const result = spawnSync("python3", [renderer, output], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status !== 0)
      throw new Error(
        "Synthetic rendering failed; verify the local dev-only Pillow/font installation"
      );
    process.stdout.write(
      `Generated ${fixtures.length} synthetic fixtures in the private output directory.\n`
    );
    return;
  }
  const input = await privateDirectory(process.env.INVOICE_EVAL_INPUT_DIR);
  const raw = await readFile(path.join(input, "samples.json"), "utf8");
  if (raw.length > 64 * 1024 * 1024)
    throw new Error("Evaluation samples exceed the offline input limit");
  const samples = z.array(sampleSchema).min(1).max(500).parse(JSON.parse(raw));
  const report = evaluateInvoices(fixtures, samples);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 }
  );
  const pass =
    report.models.length > 0 && report.models.some((model) => model.passed);
  process.stdout.write(
    `Evaluated ${samples.length} samples across ${report.models.length} models. Release gate: ${pass ? "pass" : "fail"}. Private report saved.\n`
  );
  if (!pass) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write(
    "Invoice evaluation failed; check private paths, sample schema and fixture renderer prerequisites.\n"
  );
  process.exitCode = 1;
});
