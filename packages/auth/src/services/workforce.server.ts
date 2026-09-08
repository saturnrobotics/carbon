import {
  type IdentityBinding,
  parseTrustedCallerConfiguration,
  type TrustedCallerConfiguration,
  type TrustedTokenVerifier,
  type VerifiedWorkforceIdentity,
  verifyWorkforceRequest,
  type WorkforceIdentityStore
} from "@carbon/knowledge/identity.server";

export { PORTAL_USER_EVIDENCE_HEADER } from "@carbon/knowledge/identity.server";

import type { Database } from "@carbon/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCarbonServiceRole,
  getUserScopedClient
} from "../lib/supabase/client.server";
import type { Permission } from "../types";
import { getFreshUserClaims } from "./users.server";

export type AuthorizedWorkforceRequest = VerifiedWorkforceIdentity & {
  client: SupabaseClient<Database>;
  permissions: Record<string, Permission>;
  role: string | null;
};

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

  return {
    ...identity,
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
