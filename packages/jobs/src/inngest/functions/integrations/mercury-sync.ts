import { getCarbonServiceRole } from "@carbon/auth/client.server";
import {
  GMAIL_ACCOUNTS_JSON,
  MERCURY_API_TOKEN,
  PAYMENT_SYNC_COMPANY_ID
} from "@carbon/env";
import { getJobDatabaseClient } from "../../../db";
import { parseGmailAccounts } from "../../../payment-sync/config";
import { MercuryClient } from "../../../payment-sync/providers";
import { runMercurySync } from "../../../payment-sync/sync";
import { inngest } from "../../client";

export const mercurySyncFunction = inngest.createFunction(
  { id: "mercury-payment-sync", retries: 2, concurrency: 1 },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const companyId = PAYMENT_SYNC_COMPANY_ID;
    const token = MERCURY_API_TOKEN;
    if (!companyId || !token) return { state: "unconfigured" };
    // Only counts/status enter Inngest's run history. Bank data, email content,
    // signed attachment URLs, and credentials never become step outputs.
    return await step.run("sync-private-payment-evidence", async () => {
      let mailboxes: ReturnType<typeof parseGmailAccounts> = [];
      let gmailConfigError: string | undefined;
      try {
        mailboxes = parseGmailAccounts(GMAIL_ACCOUNTS_JSON);
      } catch {
        gmailConfigError = "gmail_configuration_invalid";
      }
      return runMercurySync({
        db: getJobDatabaseClient(5),
        storage: getCarbonServiceRole().storage,
        companyId,
        mercury: new MercuryClient(token),
        mailboxes,
        gmailConfigError
      });
    });
  }
);
