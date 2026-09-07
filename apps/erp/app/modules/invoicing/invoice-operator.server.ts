/** Private, manifest-driven operations in the exact deployed Ops image. */
import { createHash } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { createClient } from "@supabase/supabase-js";
import { sql } from "kysely";
import { z } from "zod";
import { getJobDatabaseClient } from "../../../../../packages/jobs/src/db";
import { registerMercuryInvoiceSources } from "../../../../../packages/jobs/src/invoice-intake/backfill";
import {
  getInvoiceDocumentSources,
  hasInvoiceReviewFacts,
  INVOICE_PROMPT_VERSION,
  INVOICE_SCHEMA_VERSION,
  invoiceExtractionEnvelopeSchema
} from "../../../../../packages/jobs/src/invoice-intake/contracts";
import {
  createGoogleInvoiceProvider,
  loadInvoiceProviderConfig
} from "../../../../../packages/jobs/src/invoice-intake/provider";
import { setInvoiceIntakeValidation } from "../../../../../packages/jobs/src/invoice-intake/validation";
import { runInvoiceIntake } from "../../../../../packages/jobs/src/invoice-intake/worker";
import { MercuryClient } from "../../../../../packages/jobs/src/payment-sync/providers";
import { refreshMercurySupportingDocuments } from "../../../../../packages/jobs/src/payment-sync/sync";
import type { invoiceIntakeSettingsValidator } from "./invoicing.models";
import {
  getInvoiceIntakePermissions,
  getInvoiceIntakeReview,
  saveInvoiceIntakeSettings,
  setInvoiceIntakeStatus,
  validateHydratedInvoiceIntake
} from "./invoicing.server";
import { saveMercurySettings } from "./mercury.server";

const identifier = z.string().min(1).max(255);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const invoiceOperatorConfigSchema = z
  .object({
    companyId: identifier,
    userId: identifier,
    requiredRevision: z.string().regex(/^[a-f0-9]{40}$/),
    identity: z.object({
      modelId: identifier,
      promptVersion: identifier,
      schemaVersion: identifier
    }),
    maxNewExtractions: z.number().int().min(0).max(10).default(0),
    steps: z
      .array(
        z.discriminatedUnion("action", [
          z.object({ action: z.literal("refresh"), importId: identifier }),
          z.object({
            action: z.literal("normalize"),
            intakeId: identifier,
            expectedRevision: z.number().int().min(0)
          }),
          z.object({
            action: z.enum(["parse", "reuse"]),
            intakeId: identifier,
            expectedRevision: z.number().int().min(0),
            sha256: hash
          })
        ])
      )
      .min(1)
      .max(100)
  })
  .strict();
type Config = z.infer<typeof invoiceOperatorConfigSchema>;
type Settings = {
  invoice: z.infer<typeof invoiceIntakeSettingsValidator>;
  mercury: Parameters<typeof saveMercurySettings>[3];
};
type Checkpoint = {
  configHash: string;
  restoreRequired: boolean;
  original: Settings;
  baseline: string;
  completed: number[];
  inFlight?: { step: number; generation: number };
};
const nativeTables = [
  "supplier",
  "item",
  "purchaseInvoice",
  "purchaseInvoiceLine",
  "itemLedger",
  "costLedger",
  "receipt",
  "journal",
  "journalLine",
  "payment",
  "supplierLedger"
];
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function privateRead(file: string) {
  if ((await stat(file)).mode & 0o077)
    throw new Error("Operator inputs must be mode 0600");
  return JSON.parse(await readFile(file, "utf8"));
}
async function privateWrite(file: string, value: unknown) {
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), {
    mode: 0o600
  });
  await rename(`${file}.tmp`, file);
}
async function snapshot(db: Kysely<KyselyDatabase>, companyId: string) {
  const native = await sql<{ name: string; hash: string }>`
    ${sql.join(
      nativeTables.map(
        (table) => sql`SELECT ${table}::text AS name,
      md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash
      FROM ${sql.table(table)} t WHERE "companyId"=${companyId}`
      ),
      sql` UNION ALL `
    )}`.execute(db);
  const imports = await db
    .selectFrom("mercuryTransactionImport")
    .select(["id", "reviewStatus", "supplierId", "purchaseInvoiceId"])
    .where("companyId", "=", companyId)
    .orderBy("id")
    .execute();
  return digest({
    native: native.rows.sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    imports
  });
}

/** A previous attempt is evidence only for the exact document and inference contract. */
export function reusableInvoiceAttempt(
  attempt: {
    operation: string | null;
    status: string | null;
    modelId: string | null;
    promptVersion: string | null;
    schemaVersion: string | null;
    storagePath: string | null;
    extractedData: unknown;
  },
  identity: Config["identity"],
  paths: readonly string[]
) {
  return (
    attempt.operation === "extract" &&
    attempt.status === "completed" &&
    attempt.modelId === identity.modelId &&
    attempt.promptVersion === identity.promptVersion &&
    attempt.schemaVersion === identity.schemaVersion &&
    !!attempt.storagePath &&
    paths.includes(attempt.storagePath) &&
    invoiceExtractionEnvelopeSchema.safeParse(attempt.extractedData).success
  );
}

export async function runInvoiceOperator(
  directory: string,
  mode: "check" | "apply" | "recover"
) {
  const config = invoiceOperatorConfigSchema.parse(
    await privateRead(path.join(directory, "operator.json"))
  );
  if (
    mode !== "recover" &&
    config.requiredRevision !== process.env.INVOICE_OPERATOR_REVISION
  )
    throw new Error("Deployed revision mismatch");
  if (
    mode !== "check" &&
    process.env.INVOICE_OPERATOR_SCHEDULER_PAUSED !== "true"
  )
    throw new Error("Scheduler pause required");
  const actor = { companyId: config.companyId, userId: config.userId };
  const db = getJobDatabaseClient(5);
  const checkpointFile = path.join(directory, "checkpoint.json");
  const configHash = digest(config);
  let checkpoint: Checkpoint | undefined;
  try {
    try {
      checkpoint = (await privateRead(checkpointFile)) as Checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (checkpoint && checkpoint.configHash !== configHash)
      throw new Error(
        "Checkpoint belongs to another manifest; use a new private directory"
      );
    const permissions = await getInvoiceIntakePermissions(db, actor);
    if (!permissions.canSettings || !permissions.canUpdate)
      throw new Error("Invoice-update and settings permissions required");
    const model = loadInvoiceProviderConfig();
    if (
      mode !== "recover" &&
      (config.identity.schemaVersion !== INVOICE_SCHEMA_VERSION ||
        config.identity.promptVersion !== INVOICE_PROMPT_VERSION ||
        config.identity.modelId !== model.model)
    )
      throw new Error(
        "Manifest inference identity differs from deployed schema, prompt, or model"
      );
    const inspect = async (connection: Kysely<KyselyDatabase>) => {
      const intakes = await connection
        .selectFrom("invoiceIntake")
        .selectAll()
        .where("companyId", "=", actor.companyId)
        .execute();
      const sources = await connection
        .selectFrom("invoiceIntakeSource")
        .selectAll()
        .where("companyId", "=", actor.companyId)
        .execute();
      const attempts = await connection
        .selectFrom("documentExtraction")
        .selectAll()
        .where("companyId", "=", actor.companyId)
        .where("intakeId", "is not", null)
        .execute();
      return { intakes, sources, attempts };
    };
    if (mode === "check") {
      await db.transaction().execute(async (trx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        // Snapshot and plan are private artifacts; this mode never changes rows,
        // downloads bank data, or constructs a model provider.
        const baseline = await snapshot(trx, actor.companyId);
        const current = await inspect(trx);
        const steps = config.steps.map((step) => {
          if (step.action === "refresh")
            return {
              ...step,
              check: "explicit bank GET and source registration requested"
            };
          const intake = current.intakes.find(
            (row) => row.id === step.intakeId
          );
          const sources = getInvoiceDocumentSources(
            current.sources.filter((row) => row.intakeId === step.intakeId)
          );
          const attempts = current.attempts.filter(
            (row) => row.intakeId === step.intakeId
          );
          return {
            ...step,
            exists: !!intake,
            currentRevision: intake?.revision,
            status: intake?.status,
            revisionMatches: intake?.revision === step.expectedRevision,
            sourceHashes: [...new Set(sources.map((row) => row.sha256))],
            reusableAttemptIds:
              "sha256" in step
                ? attempts
                    .filter((attempt) =>
                      reusableInvoiceAttempt(
                        attempt,
                        config.identity,
                        sources
                          .filter((source) => source.sha256 === step.sha256)
                          .map((source) => source.storagePath!)
                      )
                    )
                    .map((attempt) => attempt.id)
                : []
          };
        });
        await privateWrite(path.join(directory, "check.json"), {
          configHash,
          baseline,
          identity: config.identity,
          steps
        });
      });
      return;
    }
    const restore = async () => {
      if (!checkpoint?.restoreRequired) return;
      if (checkpoint.inFlight) {
        const step = config.steps[checkpoint.inFlight.step];
        if (!step || step.action !== "parse")
          throw new Error("Invalid interrupted extraction checkpoint");
        // A worker may return retry, or finish after the operator was killed.
        // Disarm only this admitted generation before restoring the scheduler.
        // Keep its raw attempt and reviewed facts; a human chooses any retry.
        await db
          .updateTable("invoiceIntake")
          .set({
            status: "NeedsReview",
            revision: sql`"revision" + 1`,
            activeExtractionId: null,
            lastErrorCode: "invoice_operator_review_required",
            updatedBy: actor.userId,
            updatedAt: sql`now()`
          })
          .where("companyId", "=", actor.companyId)
          .where("id", "=", step.intakeId)
          .where("generation", "=", checkpoint.inFlight.generation)
          .where("status", "in", ["Queued", "Processing"])
          .execute();
      }
      await saveInvoiceIntakeSettings(db, actor, checkpoint.original.invoice);
      await saveMercurySettings(
        db,
        actor.companyId,
        actor.userId,
        checkpoint.original.mercury
      );
      checkpoint.restoreRequired = false;
      await privateWrite(checkpointFile, checkpoint);
    };
    if (mode === "recover") {
      await restore();
      return;
    }
    if (checkpoint?.restoreRequired)
      throw new Error("Recover interrupted settings before resuming apply");
    const checked = await privateRead(path.join(directory, "check.json"));
    if (checked.configHash !== configHash)
      throw new Error("Run check for this exact manifest first");
    if (!checkpoint) {
      if ((await snapshot(db, actor.companyId)) !== checked.baseline)
        throw new Error("Financial or Mercury links changed since check");
      const invoice = await db
        .selectFrom("invoiceIntakeSettings")
        .selectAll()
        .where("companyId", "=", actor.companyId)
        .executeTakeFirstOrThrow();
      const mercury = await db
        .selectFrom("mercurySyncSettings")
        .selectAll()
        .select(sql<string | null>`"syncFromDate"::text`.as("syncFromDate"))
        .where("companyId", "=", actor.companyId)
        .executeTakeFirstOrThrow();
      checkpoint = {
        configHash,
        restoreRequired: false,
        completed: [],
        baseline: checked.baseline,
        original: {
          invoice: {
            enabled: invoice.enabled,
            automaticMercuryIntake: invoice.automaticMercuryIntake,
            dailyBudgetUsd: Number(invoice.dailyBudgetUsd),
            monthlyBudgetUsd: Number(invoice.monthlyBudgetUsd)
          },
          mercury: {
            enabled: mercury.enabled,
            gmailEnabled: mercury.gmailEnabled,
            disabledMailboxes: mercury.disabledMailboxes,
            syncFromDate: mercury.syncFromDate ?? undefined
          }
        }
      };
    }
    if (
      config.steps.filter((step) => step.action === "parse").length >
      config.maxNewExtractions
    )
      throw new Error("Manifest exceeds explicit extraction count limit");
    checkpoint.restoreRequired = true;
    await privateWrite(checkpointFile, checkpoint);
    const storage = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    ).storage;
    const context = { db, storage, ...actor };
    try {
      await saveInvoiceIntakeSettings(db, actor, {
        ...checkpoint.original.invoice,
        enabled: false,
        automaticMercuryIntake: false
      });
      await saveMercurySettings(db, actor.companyId, actor.userId, {
        ...checkpoint.original.mercury,
        enabled: config.steps.some((step) => step.action === "refresh"),
        gmailEnabled: false
      });
      setInvoiceIntakeValidation(validateHydratedInvoiceIntake);
      for (const [index, step] of config.steps.entries()) {
        if (checkpoint.completed.includes(index)) continue;
        if (step.action === "refresh") {
          const result = await refreshMercurySupportingDocuments(
            {
              ...context,
              mercury: new MercuryClient(process.env.MERCURY_API_TOKEN!),
              mailboxes: [],
              gmailClients: []
            },
            actor.userId,
            step.importId
          );
          if (result.state !== "complete")
            throw new Error("Mercury refresh did not complete");
          await registerMercuryInvoiceSources(context, step.importId);
        } else {
          let review = await getInvoiceIntakeReview(db, actor, step.intakeId);
          if (["Approved", "Linked", "Ignored"].includes(review.intake.status))
            throw new Error("Terminal intake requires manual review");
          const inFlight =
            checkpoint.inFlight?.step === index
              ? checkpoint.inFlight
              : undefined;
          if (!inFlight && review.intake.revision !== step.expectedRevision)
            throw new Error("Intake changed since manifest review");
          const sources = getInvoiceDocumentSources(review.sources);
          if (step.action === "normalize") {
            if (sources.length)
              throw new Error("Normalize is only for missing-document intake");
            if (review.intake.status !== "NeedsDocument")
              await setInvoiceIntakeStatus(db, actor, {
                id: step.intakeId,
                expectedRevision: review.intake.revision,
                action: "retry"
              });
          } else {
            const owned = sources.filter(
              (source) => source.sha256 === step.sha256
            );
            if (
              !owned.length ||
              (review.review.header.primarySourceSha256 &&
                review.review.header.primarySourceSha256 !== step.sha256) ||
              new Set(sources.map((source) => source.sha256)).size !== 1
            )
              throw new Error(
                "Manifest must identify the sole selected registered document"
              );
            const file = await storage
              .from("private")
              .download(owned[0].storagePath!);
            if (
              file.error ||
              !file.data ||
              createHash("sha256")
                .update(new Uint8Array(await file.data.arrayBuffer()))
                .digest("hex") !== step.sha256
            )
              throw new Error("Stored document bytes do not match manifest");
            const attempts = await db
              .selectFrom("documentExtraction")
              .selectAll()
              .where("companyId", "=", actor.companyId)
              .where("intakeId", "=", step.intakeId)
              .execute();
            const reusable = attempts.find(
              (attempt) =>
                attempt.id === review.intake.activeExtractionId &&
                attempt.generation === review.intake.generation &&
                reusableInvoiceAttempt(
                  attempt,
                  config.identity,
                  owned.map((source) => source.storagePath!)
                )
            );
            if (
              !reusable ||
              !["NeedsReview", "Ready"].includes(review.intake.status)
            ) {
              if (step.action === "reuse")
                throw new Error(
                  "No exact reusable extraction; no paid fallback allowed"
                );
              if (!model.enabled)
                throw new Error("Deployed inference is disabled");
              // Persisted intent is a spent admission, even when a crash left
              // no attempt row. Never infer that another paid call is safe.
              if (inFlight)
                throw new Error(
                  "Interrupted extraction admission requires manual inspection; no paid retry allowed"
                );
              {
                const header = review.review.header;
                if (
                  attempts.length ||
                  review.review.lines.length ||
                  review.review.supplierId ||
                  review.review.newSupplier ||
                  review.review.locationId ||
                  review.review.paymentTermId ||
                  review.review.invoiceSupplierId ||
                  review.review.invoiceSupplierContactId ||
                  review.review.invoiceSupplierLocationId ||
                  review.review.purchaseInvoiceId ||
                  hasInvoiceReviewFacts(header) ||
                  header.excludedLines.length ||
                  header.sourceAcknowledgements.length
                )
                  throw new Error(
                    "Existing work requires explicit manual review; operator will not reparse it"
                  );
                checkpoint.inFlight = {
                  step: index,
                  generation:
                    review.intake.generation +
                    (review.intake.status === "Queued" ? 0 : 1)
                };
                await privateWrite(checkpointFile, checkpoint);
                if (review.intake.status !== "Queued")
                  await setInvoiceIntakeStatus(db, actor, {
                    id: step.intakeId,
                    expectedRevision: review.intake.revision,
                    action: "retry"
                  });
                review = await getInvoiceIntakeReview(db, actor, step.intakeId);
                if (review.intake.generation !== checkpoint.inFlight.generation)
                  throw new Error(
                    "Intake generation changed during queue preparation"
                  );
              }
              await saveInvoiceIntakeSettings(db, actor, {
                ...checkpoint.original.invoice,
                enabled: true,
                automaticMercuryIntake: false
              });
              const work = await runInvoiceIntake({
                ...context,
                intakeId: step.intakeId,
                generation: checkpoint.inFlight!.generation,
                provider: createGoogleInvoiceProvider(model)
              });
              await saveInvoiceIntakeSettings(db, actor, {
                ...checkpoint.original.invoice,
                enabled: false,
                automaticMercuryIntake: false
              });
              if (work.state !== "complete")
                throw new Error(
                  "Extraction needs inspection; checkpoint retained, no automatic paid retry"
                );
            }
          }
        }
        checkpoint.completed.push(index);
        delete checkpoint.inFlight;
        await privateWrite(checkpointFile, checkpoint);
      }
      if ((await snapshot(db, actor.companyId)) !== checkpoint.baseline)
        throw new Error(
          "Native financial rows or Mercury approval links changed during operations"
        );
      await privateWrite(path.join(directory, "result.json"), {
        completed: checkpoint.completed.length,
        financialAndMercuryLinksUnchanged: true,
        identity: config.identity
      });
    } finally {
      setInvoiceIntakeValidation(undefined);
      await restore();
    }
  } finally {
    setInvoiceIntakeValidation(undefined);
    await db.destroy();
  }
}
