import {
  type CallerAssurance,
  type IdentityBinding,
  type PrincipalAssurance,
  parseTrustedCallerConfiguration,
  type TrustedCallerConfiguration,
  type TrustedTokenVerifier,
  type VerifiedWorkforceIdentity,
  verifyWorkforceRequest,
  type WorkforceIdentityStore
} from "@carbon/knowledge/identity.server";

export { PORTAL_USER_EVIDENCE_HEADER } from "@carbon/knowledge/identity.server";

import type { Database } from "@carbon/database";
import { CONTROLLED_ENVIRONMENT } from "@carbon/env";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCarbonServiceRole,
  getUserScopedClient
} from "../lib/supabase/client.server";
import type { Permission } from "../types";
import { userHasVerifiedTotpFactor } from "./mfa.server";
import { getFreshUserClaims } from "./users.server";

export type AuthorizedWorkforceRequest = Omit<
  VerifiedWorkforceIdentity,
  "principal"
> & {
  principal: VerifiedWorkforceIdentity["principal"] & {
    assurance: PrincipalAssurance;
  };
  client: SupabaseClient<Database>;
  permissions: Record<string, Permission>;
  role: string | null;
};

/**
 * Whether a delegated request carries evidence of a recent Carbon MFA session.
 *
 * The forwarding contract (`createWorkforceForwardingHeaders`) carries exactly
 * three things: the calling service's ID token, the user's IAP assertion and
 * the company id. None of them is a Carbon session, and an IAP signature or
 * access level must never be read as one. Until the contract carries a
 * verified Carbon session marker there is nothing to check, so this is a
 * constant: under `carbon-mfa`, a company that requires MFA cannot be served
 * through the delegated path and its users are sent to sign in to Carbon.
 */
const CARBON_MFA_SESSION_EVIDENCE_FORWARDED: boolean = false;

/**
 * Carbon's MFA requirement for the company, read the way the ERP shell reads
 * it: a controlled deployment forces it on regardless of the company toggle.
 * Fails closed — a requirement that cannot be read cannot be met.
 */
async function companyRequiresMfa(
  client: SupabaseClient<Database>,
  companyId: string
): Promise<boolean> {
  if (CONTROLLED_ENVIRONMENT) return true;
  const { data, error } = await client
    .from("companySettings")
    .select("requireMfa")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error("Failed to read the company MFA requirement");
  return data?.requireMfa === true;
}

/**
 * The assurance verdict for a verified delegated principal. It reads the
 * requirement and the factor state and reports; it never touches a Carbon
 * session, so nothing here can mark one as having passed a challenge.
 */
export async function evaluateWorkforceAssurance(options: {
  client: SupabaseClient<Database>;
  companyId: string;
  actorId: string;
  assurance: CallerAssurance;
}): Promise<PrincipalAssurance> {
  const method = options.assurance.mode;
  const required = await companyRequiresMfa(options.client, options.companyId);
  if (!required) return { required, satisfied: true, method };
  if (method === "workspace-equivalent") {
    // verifyWorkforceRequest already required the documented access level;
    // the operator's recorded equivalence is what satisfies the requirement.
    return { required, satisfied: true, method };
  }
  const factorEnrolled = await userHasVerifiedTotpFactor(options.actorId);
  return {
    required,
    satisfied: factorEnrolled && CARBON_MFA_SESSION_EVIDENCE_FORWARDED,
    method
  };
}

export async function authorizeWorkforceRequest(options: {
  request: Request;
  operation: string;
  configuration: TrustedCallerConfiguration;
  identityStore: WorkforceIdentityStore;
  tokenVerifier?: TrustedTokenVerifier;
}): Promise<AuthorizedWorkforceRequest> {
  const identity = await verifyWorkforceRequest(options);
  const { actorId, companyId } = identity.principal;
  const [client, claims] = await Promise.all([
    getUserScopedClient(actorId),
    getFreshUserClaims(actorId, companyId)
  ]);
  const assurance = await evaluateWorkforceAssurance({
    client,
    companyId,
    actorId,
    assurance: identity.assurance
  });

  return {
    ...identity,
    principal: { ...identity.principal, assurance },
    client,
    permissions: claims.permissions,
    role: claims.role
  };
}

function isIdentityBinding(value: unknown): value is IdentityBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.actorId === "string" &&
    typeof binding.companyId === "string" &&
    typeof binding.companyGroupId === "string" &&
    typeof binding.bindingActive === "boolean" &&
    typeof binding.userActive === "boolean" &&
    typeof binding.membershipActive === "boolean" &&
    typeof binding.revocationVersion === "number" &&
    typeof binding.permissionsVersion === "string" &&
    Array.isArray(binding.capabilities) &&
    binding.capabilities.every((capability) => typeof capability === "string")
  );
}

export function createCarbonWorkforceIdentityStore(): WorkforceIdentityStore {
  const serviceRole = getCarbonServiceRole() as unknown as {
    rpc(
      name: string,
      args: Record<string, string>
    ): Promise<{ data: unknown; error: unknown }>;
  };
  return {
    async resolveHuman(identity) {
      const { data, error } = await serviceRole.rpc(
        "knowledge_resolve_workforce_identity",
        {
          requested_issuer: identity.issuer,
          requested_subject: identity.subject,
          requested_company_id: identity.companyId
        }
      );
      if (error || !isIdentityBinding(data)) return null;
      return data;
    }
  };
}

export function authorizeCarbonWorkforceRequest(options: {
  request: Request;
  operation: string;
  configurationJson?: string;
}) {
  const configurationJson =
    options.configurationJson ?? process.env.KNOWLEDGE_TRUSTED_CALLERS_JSON;
  if (!configurationJson)
    throw new Error("Workforce authentication is not configured");
  return authorizeWorkforceRequest({
    request: options.request,
    operation: options.operation,
    configuration: parseTrustedCallerConfiguration(configurationJson),
    identityStore: createCarbonWorkforceIdentityStore()
  });
}
