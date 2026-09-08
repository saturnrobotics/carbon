import { z } from "zod";

export const MANUAL_RELEASE_PROFILE = "manual-v1";
export const manualSourceConfigurationSchema = z
  .object({
    sourceId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    displayName: z.string().trim().min(1).max(200)
  })
  .strict();

/** v1 is an explicit release boundary, not a switch that enables unfinished work. */
export function readManualSourceConfiguration(
  environment: Record<string, string | undefined>
) {
  if (
    environment.KNOWLEDGE_RELEASE_PROFILE &&
    environment.KNOWLEDGE_RELEASE_PROFILE !== MANUAL_RELEASE_PROFILE
  )
    throw Error("Unsupported knowledge release profile");
  if (!environment.KNOWLEDGE_MANUAL_SOURCE_JSON)
    throw Error("Manual source configuration is required");
  return manualSourceConfigurationSchema.parse(
    JSON.parse(environment.KNOWLEDGE_MANUAL_SOURCE_JSON)
  );
}
