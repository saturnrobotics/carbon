/** Explicit Ops-only paid evaluation. Normal unit runs skip this harness. */
import { randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getJobDatabaseClient } from "../../../../../packages/jobs/src/db";
import {
  evaluateInvoices,
  type InvoiceEvaluationSample
} from "../../../../../packages/jobs/src/invoice-intake/evaluation";
import { syntheticInvoiceFixtures } from "../../../../../packages/jobs/src/invoice-intake/fixtures/synthetic";
import {
  assertInvoiceSourceAccess,
  registerInvoiceSource
} from "../../../../../packages/jobs/src/invoice-intake/ingestion";
import {
  createGoogleInvoiceProvider,
  loadInvoiceProviderConfig
} from "../../../../../packages/jobs/src/invoice-intake/provider";
import { setInvoiceIntakeValidation } from "../../../../../packages/jobs/src/invoice-intake/validation";
import { runInvoiceIntake } from "../../../../../packages/jobs/src/invoice-intake/worker";

const modelSchema = z
  .object({
    companyId: z.string().min(1).optional(),
    id: z.enum(["gemini-3.5-flash", "gemini-3.5-flash-lite"]),
    inputPrice: z.number().positive(),
    outputPrice: z.number().positive()
  })
  .strict();
const configSchema = z
  .object({
    userId: z.string().min(1),
    runId: z.uuid().optional(),
    project: z.string().min(1),
    priceVerifiedAt: z.string(),
    maxCostUsd: z.number().positive().max(20),
    models: z.array(modelSchema).min(1).max(2)
  })
  .strict();

async function privateJson(file: string, value: unknown) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

describe.skipIf(process.env.INVOICE_EVAL_LIVE !== "true")(
  "live budgeted invoice evaluation",
  () => {
    it("extracts the synthetic corpus through the deployed worker and canonical ERP validation", async () => {
      if (process.env.INVOICE_EVAL_SCHEDULER_PAUSED !== "true")
        throw new Error(
          "Pause scheduler dispatch before testing an alternate configured model"
        );
      const directory = process.env.INVOICE_EVAL_DIRECTORY;
      if (!directory || !path.isAbsolute(directory))
        throw new Error("Private evaluation directory required");
      const configFile = path.join(directory, "live.json");
      if ((await stat(configFile)).mode & 0o077)
        throw new Error("Private live configuration must be mode 0600");
      const config = configSchema.parse(
        JSON.parse(await readFile(configFile, "utf8"))
      );
      const fixtures = syntheticInvoiceFixtures();
      const rendered = JSON.parse(
        await readFile(path.join(directory, "fixtures.json"), "utf8")
      );
      if (JSON.stringify(rendered) !== JSON.stringify(fixtures))
        throw new Error(
          "Regenerate this revision's complete synthetic corpus before live evaluation"
        );
      const { getInvoiceIntakeReview, validateHydratedInvoiceIntake } =
        await import("./invoicing.server");
      const {
        bootstrapInvoiceEvaluationCompany,
        prepareInvoiceEvaluationCatalog,
        teachInvoiceEvaluationFixture,
        expectedInvoiceRepeat
      } = await import("./invoice-evaluation-training.server");
      setInvoiceIntakeValidation(validateHydratedInvoiceIntake);
      const db = getJobDatabaseClient(5);
      const client = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      const storage = client.storage;
      let samples: InvoiceEvaluationSample[] = [];
      try {
        samples = z
          .array(
            z.object({
              fixtureId: z.string(),
              modelId: z.string(),
              attemptId: z.string(),
              result: z.unknown(),
              status: z.string(),
              latencyMs: z.number().finite().nonnegative(),
              actualCostUsd: z.number().finite().nonnegative().nullable(),
              repeatSelection: z
                .object({ expected: z.unknown(), actual: z.unknown() })
                .optional()
            })
          )
          .max(60)
          .parse(
            JSON.parse(
              await readFile(path.join(directory, "samples.json"), "utf8")
            )
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        samples.some(
          (sample) =>
            !config.models.some((model) => model.id === sample.modelId)
        )
      )
        throw new Error(
          "Use a separate evaluation directory for each candidate configuration"
        );
      const candidateBudget = config.maxCostUsd / config.models.length;
      const candidateFailures: Array<{ modelId: string; reason: string }> = [];
      try {
        if (!config.runId) {
          config.runId = randomUUID();
          await privateJson(configFile, config);
        }
        for (const model of config.models) {
          if (!model.companyId) {
            model.companyId = await bootstrapInvoiceEvaluationCompany(
              db,
              client,
              config.userId,
              config.runId,
              model.id
            );
            await privateJson(configFile, config);
          }
          const actor = { companyId: model.companyId, userId: config.userId };
          await assertInvoiceSourceAccess(db, actor);
          const company = await db
            .selectFrom("company")
            .select("name")
            .where("id", "=", actor.companyId)
            .executeTakeFirstOrThrow();
          if (!company.name.startsWith("Invoice Inference Evaluation"))
            throw new Error(
              "Use an explicitly named synthetic evaluation company"
            );
          const catalog = await prepareInvoiceEvaluationCatalog(
            db,
            actor,
            fixtures
          );
          const provider = createGoogleInvoiceProvider(
            loadInvoiceProviderConfig({
              INVOICE_INTAKE_ENABLED: "true",
              INVOICE_AI_PROJECT: config.project,
              INVOICE_AI_LOCATION: "us",
              INVOICE_AI_MODEL: model.id,
              INVOICE_AI_INPUT_PRICE_USD_PER_MILLION: String(model.inputPrice),
              INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION: String(
                model.outputPrice
              ),
              INVOICE_AI_PRICE_VERIFIED_AT: config.priceVerifiedAt
            })
          );
          const existing = await db
            .selectFrom("invoiceIntakeSettings")
            .selectAll()
            .where("companyId", "=", actor.companyId)
            .executeTakeFirst();
          await db
            .insertInto("invoiceIntakeSettings")
            .values({
              companyId: actor.companyId,
              createdBy: actor.userId,
              enabled: true,
              automaticMercuryIntake: false,
              dailyBudgetUsd: candidateBudget,
              monthlyBudgetUsd: candidateBudget
            })
            .onConflict((oc) =>
              oc.column("companyId").doUpdateSet({
                enabled: true,
                automaticMercuryIntake: false,
                dailyBudgetUsd: Math.min(
                  candidateBudget,
                  existing?.dailyBudgetUsd ?? candidateBudget
                ),
                monthlyBudgetUsd: Math.min(
                  candidateBudget,
                  existing?.monthlyBudgetUsd ?? candidateBudget
                )
              })
            )
            .execute();
          try {
            for (const fixture of fixtures) {
              const suffix =
                fixture.format === "photo" && fixture.pages.length === 1
                  ? "jpg"
                  : "pdf";
              const bytes = new Uint8Array(
                await readFile(path.join(directory, `${fixture.id}.${suffix}`))
              );
              const intake = await registerInvoiceSource(db, storage, actor, {
                kind: "upload",
                sourceKey: `evaluation:${fixture.id}`,
                fileName: `${fixture.id}.${suffix}`,
                bytes
              });
              const before = await db
                .selectFrom("invoiceIntake")
                .select(["status", "generation"])
                .where("companyId", "=", actor.companyId)
                .where("id", "=", intake.intakeId)
                .executeTakeFirstOrThrow();
              const checkpoint = samples.find(
                (sample) =>
                  sample.fixtureId === fixture.id && sample.modelId === model.id
              );
              if (checkpoint) {
                // Resume training after a saved machine observation, never rescore an already corrected review.
                await teachInvoiceEvaluationFixture(
                  db,
                  actor,
                  intake.intakeId,
                  fixture,
                  catalog
                );
                continue;
              }
              if (
                ["Approved", "Linked"].includes(before.status) &&
                !fixture.duplicateOf
              )
                throw new Error(
                  "A corrected training document lacks its initial machine observation checkpoint"
                );
              if (["Queued", "Processing"].includes(before.status)) {
                // Normal persisted admission owns every paid call; no immediate retry loop bypasses its schedule.
                await runInvoiceIntake({
                  db,
                  storage,
                  companyId: actor.companyId,
                  intakeId: intake.intakeId,
                  generation: before.generation,
                  provider
                });
              }
              const attempt = await db
                .selectFrom("documentExtraction")
                .selectAll()
                .select(
                  sql<number>`extract(epoch from ("updatedAt"-"reservedAt"))*1000`.as(
                    "latencyMs"
                  )
                )
                .where("companyId", "=", actor.companyId)
                .where("intakeId", "=", intake.intakeId)
                .where("generation", "=", before.generation)
                .where("operation", "=", "extract")
                .orderBy("attemptNumber", "desc")
                .executeTakeFirst();
              if (!attempt || attempt.modelId !== model.id)
                throw new Error(
                  "Evaluation worker was not admitted with the requested model; inspect private attempt history"
                );
              const review = await getInvoiceIntakeReview(
                db,
                actor,
                intake.intakeId
              );
              const observed = {
                supplierId: review.review.supplierId,
                lines: review.review.lines.map((line) => ({
                  itemId: line.itemId,
                  purchaseUnit: line.purchaseUnit,
                  stockUnit: line.stockUnit,
                  conversionFactor: line.conversionFactor
                }))
              };
              const duplicate = fixture.duplicateOf
                ? samples.find(
                    (sample) =>
                      sample.fixtureId === fixture.duplicateOf &&
                      sample.modelId === model.id
                  )
                : null;
              if (
                fixture.duplicateOf &&
                (!duplicate || attempt.id !== duplicate.attemptId)
              )
                throw new Error(
                  "Exact duplicate source did not reuse its original paid attempt"
                );
              samples.push(
                duplicate
                  ? { ...duplicate, fixtureId: fixture.id }
                  : {
                      fixtureId: fixture.id,
                      modelId: model.id,
                      attemptId: attempt.id,
                      result: attempt.extractedData,
                      status:
                        review.intake.status === "Ready" &&
                        review.validation.ready
                          ? "Ready"
                          : "NeedsReview",
                      latencyMs: Number(attempt.latencyMs ?? 0),
                      actualCostUsd:
                        attempt.actualCostUsd === null
                          ? null
                          : Number(attempt.actualCostUsd),
                      ...(fixture.heldOutRepeat
                        ? {
                            repeatSelection: {
                              expected: expectedInvoiceRepeat(catalog, fixture),
                              actual: observed
                            }
                          }
                        : {})
                    }
              );
              await privateJson(path.join(directory, "samples.json"), samples);
              await teachInvoiceEvaluationFixture(
                db,
                actor,
                intake.intakeId,
                fixture,
                catalog
              );
              await privateJson(path.join(directory, "report.json"), {
                ...evaluateInvoices(fixtures, samples),
                candidateFailures
              });
              process.stdout.write(
                `Evaluated ${samples.length} synthetic samples.\n`
              );
            }
          } catch {
            candidateFailures.push({
              modelId: model.id,
              reason: "evaluation_incomplete"
            });
          } finally {
            await db
              .updateTable("invoiceIntakeSettings")
              .set({
                enabled: existing?.enabled ?? false,
                automaticMercuryIntake:
                  existing?.automaticMercuryIntake ?? false,
                dailyBudgetUsd: existing?.dailyBudgetUsd ?? 5,
                monthlyBudgetUsd: existing?.monthlyBudgetUsd ?? 50
              })
              .where("companyId", "=", actor.companyId)
              .execute();
          }
        }
        const report = evaluateInvoices(fixtures, samples);
        await privateJson(path.join(directory, "report.json"), {
          ...report,
          candidateFailures
        });
        expect(report.models.some((model) => model.passed)).toBe(true);
      } finally {
        setInvoiceIntakeValidation(undefined);
        await db.destroy();
      }
    });
  }
);

// This explicit preflight imports the real production modules without performing a database or provider operation.
describe.skipIf(process.env.INVOICE_EVAL_IMPORT_CHECK !== "true")(
  "invoice live harness import preflight",
  () => {
    it("loads native review, approval and teaching with production macro transforms", async () => {
      const server = await import("./invoicing.server");
      const training = await import("./invoice-evaluation-training.server");
      expect(typeof server.validateHydratedInvoiceIntake).toBe("function");
      expect(typeof server.approveInvoiceIntake).toBe("function");
      expect(typeof training.teachInvoiceEvaluationFixture).toBe("function");
    });
  }
);
