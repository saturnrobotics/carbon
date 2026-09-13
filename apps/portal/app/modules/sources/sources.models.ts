import { z } from "zod";

/**
 * The Drive source contract and the pure helpers that describe one, shared by
 * the loader's parse and the page's render.
 *
 * This module must import nothing server-only, directly or transitively: the
 * page component value-imports it, so everything it reaches is bundled for the
 * BROWSER. `sources.service.ts` cannot hold these — it forwards through
 * `intake.service.ts`, which imports `services/identity.server`, and React
 * Router's `dot-server` plugin fails the build on that graph. Keep `zod` the
 * only import here; a service import in this file re-creates the same chain.
 */
export const driveSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    displayName: z.string().max(200),
    ownerId: z.string().max(256),
    classification: z.string().max(100),
    corpora: z.enum(["drive", "user"]),
    driveId: z.string().max(256).nullable(),
    rootFolderIds: z.array(z.string().max(256)).max(64),
    oauthScope: z.string().max(200),
    userAccessScope: z.string().max(200),
    domainWideDelegation: z.boolean(),
    providerPolicy: z.record(z.string(), z.unknown()),
    reconcileAfterHours: z.number().int().positive(),
    reconciledAt: z.string().max(40).nullable(),
    lastSyncAt: z.string().max(40).nullable(),
    lastSyncStatus: z.enum(["succeeded", "failed"]).nullable(),
    documentCount: z.number().int().nonnegative()
  })
  .strict();
export type DriveSource = z.infer<typeof driveSourceSchema>;
export const driveSourceListSchema = z
  .object({ sources: z.array(driveSourceSchema).max(50) })
  .strict();

/** Provider eligibility as recorded on the source: which providers may see which classifications. */
export function describeProviderEligibility(
  policy: Record<string, unknown>
): string {
  const providers = Array.isArray(policy.allowedProviders)
    ? policy.allowedProviders.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  const classifications = Array.isArray(policy.allowedClassifications)
    ? policy.allowedClassifications.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  if (!providers.length || !classifications.length)
    return "No external provider is admitted";
  return `${providers.join(", ")} for ${classifications.join(", ")}`;
}
