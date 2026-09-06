import { z } from "zod";
import type { GmailMailboxConfig } from "./providers";

const accountsSchema = z
  .array(
    z
      .object({
        email: z
          .string()
          .email()
          .transform((value) => value.toLowerCase()),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        refreshToken: z.string().min(1),
        enabled: z.boolean().default(true)
      })
      .strict()
  )
  .max(10);

export function parseGmailAccounts(
  raw: string | undefined
): GmailMailboxConfig[] {
  try {
    const accounts = accountsSchema.parse(JSON.parse(raw || "[]"));
    if (
      new Set(accounts.map((account) => account.email)).size !== accounts.length
    ) {
      throw new Error("duplicate_mailbox");
    }
    return accounts;
  } catch {
    throw new Error("gmail_configuration_invalid");
  }
}
