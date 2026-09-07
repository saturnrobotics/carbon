import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { sql } from "kysely";
import { getJobDatabaseClient } from "../../../db";
import {
  copyInvoiceAttachments,
  pendingInvoiceAttachments
} from "../../../invoice-intake/attachments";
import {
  reconcileMercuryInvoiceSources,
  runInvoiceIntakeBackfillPage
} from "../../../invoice-intake/backfill";
import {
  createGoogleInvoiceProvider,
  loadInvoiceProviderConfig
} from "../../../invoice-intake/provider";
import {
  pendingInvoiceValidations,
  validateInvoiceIntake
} from "../../../invoice-intake/validation";
import {
  pendingInvoiceIntakes,
  runInvoiceIntake,
  runInvoiceMatch
} from "../../../invoice-intake/worker";
import { inngest } from "../../client";

let provider: ReturnType<typeof createGoogleInvoiceProvider> | undefined;
function runtime() {
  provider ??= createGoogleInvoiceProvider(loadInvoiceProviderConfig());
  return {
    db: getJobDatabaseClient(5),
    storage: getCarbonServiceRole().storage,
    provider
  };
}

export const invoiceIntakeFunction = inngest.createFunction(
  { id: "invoice-intake", retries: 0, concurrency: 2 },
  { event: "carbon/invoice-intake.process" },
  async ({ event, step }) =>
    step.run("process-private-invoice", async () => {
      try {
        return await runInvoiceIntake({ ...runtime(), ...event.data });
      } catch {
        throw new Error("invoice_intake_worker_failed");
      }
    })
);

export const invoiceIntakeMatchFunction = inngest.createFunction(
  { id: "invoice-intake-match", retries: 0, concurrency: 2 },
  { event: "carbon/invoice-intake.match" },
  async ({ event, step }) =>
    step.run("suggest-private-invoice-matches", async () => {
      try {
        return await runInvoiceMatch({ ...runtime(), ...event.data });
      } catch {
        throw new Error("invoice_intake_worker_failed");
      }
    })
);

export const invoiceIntakeReconcileFunction = inngest.createFunction(
  { id: "invoice-intake-reconcile", retries: 0, concurrency: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    // Only identifiers/counts enter event history. Invoice bytes, prompts and
    // extracted evidence stay in private storage/Postgres.
    const validations = await step.run("find-invoice-readiness-recovery", () =>
      pendingInvoiceValidations(getJobDatabaseClient(5))
    );
    if (validations.length)
      await step.sendEvent(
        "resume-invoice-readiness",
        validations.map((data) => ({
          name: "carbon/invoice-intake.validate" as const,
          data
        }))
      );
    const attachments = await step.run("find-invoice-attachment-recovery", () =>
      pendingInvoiceAttachments(getJobDatabaseClient(5))
    );
    if (attachments.length)
      await step.sendEvent(
        "resume-invoice-attachments",
        attachments.map((data) => ({
          name: "carbon/invoice-intake.copy-attachments" as const,
          data
        }))
      );
    const sourceCompanies = await step.run(
      "find-invoice-source-recovery",
      async () => {
        try {
          return await getJobDatabaseClient(5)
            .selectFrom("invoiceIntakeSettings")
            .select("companyId")
            .where("automaticMercuryIntake", "=", true)
            .orderBy("companyId")
            .limit(100)
            .execute();
        } catch {
          throw new Error("invoice_intake_reconcile_failed");
        }
      }
    );
    if (sourceCompanies.length)
      await step.sendEvent(
        "resume-invoice-source-recovery",
        sourceCompanies.map((data) => ({
          name: "carbon/invoice-intake.reconcile-sources" as const,
          data
        }))
      );
    const backfills = await step.run(
      "find-durable-invoice-backfills",
      async () => {
        try {
          return (
            await sql<{
              companyId: string;
              userId: string;
            }>`SELECT "companyId",coalesce("updatedBy","createdBy") AS "userId"
          FROM public."invoiceIntakeSettings" WHERE "backfillStatus"='Running' ORDER BY "updatedAt" NULLS FIRST LIMIT 100`.execute(
              getJobDatabaseClient(5)
            )
          ).rows;
        } catch {
          throw new Error("invoice_intake_reconcile_failed");
        }
      }
    );
    if (backfills.length)
      await step.sendEvent(
        "resume-invoice-backfills",
        backfills.map((data) => ({
          name: "carbon/invoice-intake.backfill" as const,
          data
        }))
      );
    const work = await step.run("find-durable-invoice-work", async () => {
      try {
        if (!loadInvoiceProviderConfig().enabled) return [];
        return await pendingInvoiceIntakes(getJobDatabaseClient(5));
      } catch {
        throw new Error("invoice_intake_reconcile_failed");
      }
    });
    if (work.length)
      await step.sendEvent(
        "resume-invoice-work",
        work.map((data) => ({
          name: "carbon/invoice-intake.process" as const,
          data
        }))
      );
    return { dispatched: work.length };
  }
);

export const invoiceIntakeBackfillFunction = inngest.createFunction(
  {
    id: "invoice-intake-backfill",
    retries: 0,
    concurrency: { limit: 1, key: "event.data.companyId" }
  },
  { event: "carbon/invoice-intake.backfill" },
  async ({ event, step }) => {
    const result = await step.run(
      "ingest-private-historical-evidence",
      async () => {
        try {
          return await runInvoiceIntakeBackfillPage({
            db: getJobDatabaseClient(5),
            storage: getCarbonServiceRole().storage,
            ...event.data
          });
        } catch {
          throw new Error("invoice_intake_backfill_failed");
        }
      }
    );
    if (result.needsMore)
      await step.sendEvent("continue-invoice-backfill", {
        name: "carbon/invoice-intake.backfill",
        data: event.data
      });
    return { state: result.state, processed: result.processed };
  }
);

export const invoiceIntakeSourceRecoveryFunction = inngest.createFunction(
  {
    id: "invoice-intake-source-recovery",
    retries: 0,
    concurrency: { limit: 1, key: "event.data.companyId" }
  },
  { event: "carbon/invoice-intake.reconcile-sources" },
  async ({ event, step }) =>
    step.run("recover-private-source-registration", async () => {
      try {
        return await reconcileMercuryInvoiceSources({
          db: getJobDatabaseClient(5),
          storage: getCarbonServiceRole().storage,
          ...event.data
        });
      } catch {
        throw new Error("invoice_intake_source_recovery_failed");
      }
    })
);

export const invoiceIntakeAttachmentFunction = inngest.createFunction(
  { id: "invoice-intake-copy-attachments", retries: 0, concurrency: 2 },
  { event: "carbon/invoice-intake.copy-attachments" },
  async ({ event, step }) =>
    step.run("copy-private-invoice-attachments", async () => {
      try {
        return await copyInvoiceAttachments({
          db: getJobDatabaseClient(5),
          storage: getCarbonServiceRole().storage,
          ...event.data
        });
      } catch {
        throw new Error("invoice_attachment_copy_failed");
      }
    })
);

export const invoiceIntakeValidationFunction = inngest.createFunction(
  { id: "invoice-intake-validate", retries: 0, concurrency: 2 },
  { event: "carbon/invoice-intake.validate" },
  async ({ event, step }) =>
    step.run("validate-native-invoice-readiness", async () => {
      try {
        return {
          validated: await validateInvoiceIntake({
            db: getJobDatabaseClient(5),
            ...event.data
          })
        };
      } catch {
        throw new Error("invoice_intake_validation_failed");
      }
    })
);
