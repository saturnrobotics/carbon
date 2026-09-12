import { z } from "zod";
import { forwardIntakeRequest } from "../intake/intake.service";

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

function companyId(environment: NodeJS.ProcessEnv): string {
  return environment.KNOWLEDGE_COMPANY_ID?.trim() ?? "";
}

export async function listDriveSources(
  request: Request,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch
): Promise<DriveSource[]> {
  const response = await forwardIntakeRequest({
    request,
    companyId: companyId(environment),
    workerPath: "/v1/drive/sources",
    method: "GET",
    environment,
    fetchImpl
  });
  if (!response.ok) throw response;
  return driveSourceListSchema.parse(await response.json()).sources;
}

export async function requestDriveSourceSync(
  request: Request,
  sourceId: string,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(sourceId)) return false;
  const response = await forwardIntakeRequest({
    request,
    companyId: companyId(environment),
    workerPath: `/v1/drive/${encodeURIComponent(sourceId)}/sync`,
    method: "POST",
    body: "{}",
    contentType: "application/json",
    environment,
    fetchImpl
  });
  await response.body?.cancel();
  return response.status === 202;
}
