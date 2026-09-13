import { forwardIntakeRequest } from "../intake/intake.service";
import { type DriveSource, driveSourceListSchema } from "./sources.models";

/**
 * Server-side Drive source access. This module reaches
 * `services/identity.server` through `forwardIntakeRequest`, so only a loader
 * or an action may import it — never a component. The contract and its pure
 * descriptors live in `sources.models.ts`, which the page imports directly;
 * re-exporting them from here would put this graph back in the client bundle.
 */
function companyId(environment: NodeJS.ProcessEnv): string {
  return environment.PORTAL_COMPANY_ID?.trim() ?? "";
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
