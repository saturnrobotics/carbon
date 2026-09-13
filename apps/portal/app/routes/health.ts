import { readManualSourceConfiguration } from "@carbon/portal/release-profile";

const required = [
  "PORTAL_COMPANY_ID",
  "PORTAL_QUERY_AUDIENCE",
  "PORTAL_QUERY_URL",
  "PORTAL_WEB_IAP_AUDIENCE",
  "PORTAL_WEB_ORIGIN",
  "PORTAL_WORKER_AUDIENCE",
  "PORTAL_WORKER_URL"
] as const;

export function isPortalWebReady(environment: NodeJS.ProcessEnv): boolean {
  if (!required.every((key) => environment[key]?.trim())) return false;
  try {
    readManualSourceConfiguration(environment);
    return true;
  } catch {
    return false;
  }
}

export function loader() {
  const ready = isPortalWebReady(process.env);
  return Response.json(
    { status: ready ? "ok" : "not-configured", service: "portal-web" },
    { status: ready ? 200 : 503 }
  );
}
