import {
  createWorkforceForwardingHeaders,
  GoogleWorkforceTokenVerifier,
  parseTrustedCallerConfiguration,
  type VerifiedIapBrowserRequest,
  type VerifiedWorkforceIdentity,
  verifyIapBrowserRequest,
  verifyWorkforceRequest,
  type WorkforceIdentityStore
} from "@carbon/portal/identity.server";

const googleVerifier = new GoogleWorkforceTokenVerifier();

function configuredBrowser(environment: NodeJS.ProcessEnv) {
  const sourceIapAudience = environment.PORTAL_WEB_IAP_AUDIENCE;
  if (!sourceIapAudience)
    throw new Error("Workforce browser authentication is not configured");
  const requiredAccessLevels = (
    environment.PORTAL_WEB_REQUIRED_ACCESS_LEVELS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return { sourceIapAudience, requiredAccessLevels };
}

function configuredCallers(environment: NodeJS.ProcessEnv) {
  const value = environment.PORTAL_TRUSTED_CALLERS_JSON;
  if (!value) throw new Error("Workforce authentication is not configured");
  return parseTrustedCallerConfiguration(value);
}

export function verifyPortalWorkforceRequest(options: {
  request: Request;
  operation: string;
  identityStore: WorkforceIdentityStore;
  environment?: NodeJS.ProcessEnv;
}) {
  return verifyWorkforceRequest({
    request: options.request,
    operation: options.operation,
    configuration: configuredCallers(options.environment ?? process.env),
    identityStore: options.identityStore,
    tokenVerifier: googleVerifier
  });
}

export function verifyPortalBrowserRequest(
  request: Request,
  environment: NodeJS.ProcessEnv = process.env
) {
  return verifyIapBrowserRequest({
    request,
    ...configuredBrowser(environment),
    tokenVerifier: googleVerifier
  });
}

export function forwardVerifiedWorkforceRequest(options: {
  request: Request;
  targetAudience: string;
  companyId: string;
  verified: VerifiedWorkforceIdentity | VerifiedIapBrowserRequest;
}) {
  return createWorkforceForwardingHeaders(options);
}
