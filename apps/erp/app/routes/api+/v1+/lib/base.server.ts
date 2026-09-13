// oRPC context + middleware shared by the HTTP transport and the MCP/agent bridges.

import type { ManifestEntry, ToolPermission } from "@carbon/api";
import type { Permission } from "@carbon/auth";
import type { Database } from "@carbon/database";
import type { PrincipalAssurance } from "@carbon/portal/identity.server";
import { STEP_UP_REQUIRED_CODE } from "@carbon/portal/step-up";
import { ORPCError, os } from "@orpc/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isPortalOperation,
  portalCapabilityFor
} from "~/modules/portal/portal.server";
import { isMcpBlockedTool } from "../../mcp+/lib/mcp-blocked-tools";

/**
 * The identity every Carbon API call runs as. Built once per request (from an API
 * key on HTTP, or from the resolved MCP/agent auth) and injected as oRPC context;
 * the service dispatch reads `client`/`companyId`/`userId`/`companyGroupId` from it.
 */
export interface AuthedContext {
  client: SupabaseClient<Database>;
  userId: string;
  companyId: string;
  companyGroupId: string;
  /** `"api-key"` runs the per-operation scope gate. `"oauth"` (MCP connector) does
   *  not — its RLS/role already bounds it, exactly as MCP behaves today. `"session"`
   *  is an already-authorized in-process caller (the in-app agent behind the route's
   *  requirePermissions, and the workflow engine acting as the workflow's owner) —
   *  not "oauth" because that names a wire protocol, not a trust decision. */
  authKind: "api-key" | "oauth" | "session" | "workforce";
  /** The API key's scopes: `{ "<module>_<action>": [companyId, …] }`. */
  scopes: Record<string, string[]>;
  workforce?: {
    allowedOperations: readonly string[];
    capabilities: readonly string[];
    permissions: Record<string, Permission>;
    policyVersion: string;
    /** Carbon's MFA verdict for the delegated actor (`authorizeWorkforceRequest`). */
    assurance: PrincipalAssurance;
  };
}

export const base = os.$context<AuthedContext>();

/**
 * Enforce that an API-key caller holds the operation's permission. `module: null`
 * gates only on a valid key of the company (today's MCP behavior for account/shared);
 * otherwise every action in the permission must be scoped to the active company.
 * The exact-companyId check (no `"0"` wildcard) matches requirePermissions' key path.
 */
export function assertScopes(
  scopes: Record<string, string[]>,
  companyId: string,
  permission: ToolPermission
): void {
  if (permission.module === null) return;
  for (const action of permission.actions) {
    const key = `${permission.module}_${action}`;
    if (!scopes[key]?.includes(companyId)) {
      throw new ORPCError("FORBIDDEN", {
        message: `API key lacks the required scope: ${key}`
      });
    }
  }
}

/**
 * A delegated workforce caller may run an operation only when the caller
 * registry names it, the principal holds the capability the portal module
 * assigns to it (`PORTAL_OPERATIONS` — the one allowlist), and the user's
 * fresh Carbon permissions cover the operation for the active company. An
 * operation the module does not list has no capability and is refused.
 */
export function assertWorkforceAuthorization(
  context: AuthedContext,
  meta: ManifestEntry
): void {
  const workforce = context.workforce;
  const capability = portalCapabilityFor(meta.name);
  if (
    !workforce ||
    !capability ||
    !workforce.allowedOperations.includes(meta.name) ||
    !workforce.capabilities.includes(capability) ||
    meta.permission.module === null
  ) {
    throw new ORPCError("FORBIDDEN", {
      message: "Workforce caller is not authorized for this operation"
    });
  }
  for (const action of meta.permission.actions) {
    if (
      !workforce.permissions[meta.permission.module]?.[action]?.includes(
        context.companyId
      )
    ) {
      throw new ORPCError("FORBIDDEN", {
        message: "Current user permission does not authorize this operation"
      });
    }
  }
  // Checked last so the step-up message is shown only when MFA is the one
  // thing missing. The structured `data.code` is what the portal services
  // and the portal recognise; API callers see the same 403 JSON envelope.
  const { assurance } = workforce;
  if (assurance.required && !assurance.satisfied) {
    throw new ORPCError("FORBIDDEN", {
      message:
        "This request requires a Carbon sign-in with two-factor authentication",
      data: { code: STEP_UP_REQUIRED_CODE, method: assurance.method }
    });
  }
}

/** Per-operation gate middleware — runs the scope check for API-key callers.
 *  The blocked-name guard is belt-and-braces: blocked tools are already excluded
 *  from the manifest at generation time, so this only fires if that exclusion
 *  ever regresses — the surface stays closed instead of silently opening.
 *
 *  Portal operations exist only for delegated workforce callers. Every other
 *  kind — API key, OAuth connector, in-process session — gets NOT_FOUND rather
 *  than FORBIDDEN, so to them the surface is invisible, not merely closed; the
 *  same rule keeps those operations out of MCP discovery and the public OpenAPI
 *  document (`isDisclosedOperation` in operations.server.ts). */
export const gate = (meta: ManifestEntry) =>
  base.middleware(async ({ context, next }) => {
    if (isMcpBlockedTool(meta.name)) throw new ORPCError("NOT_FOUND");
    if (isPortalOperation(meta) && context.authKind !== "workforce") {
      throw new ORPCError("NOT_FOUND");
    }
    if (context.authKind === "api-key") {
      assertScopes(context.scopes, context.companyId, meta.permission);
    } else if (context.authKind === "workforce") {
      assertWorkforceAuthorization(context, meta);
    }
    return next();
  });

const PROGRAMMING_ERRORS: ReadonlyArray<Function> = [
  TypeError,
  ReferenceError,
  RangeError,
  SyntaxError
];

/**
 * Turn a service's deliberate `throw new Error(...)` into a 422 carrying its
 * message; oRPC would otherwise rewrite it to an opaque 500 with the text only
 * in `cause`, which the encoder never serializes.
 *
 * Classification is by constructor because the ERP service layer has no domain
 * error class: a plain `Error` was written by a person; a `TypeError` and friends
 * mean a real defect, so those keep their 500 with the detail withheld.
 *
 * Must NOT attach `data.supabase` — `callOperation` keys its `Database error:`
 * envelope off that field, so adding it would silently change MCP output.
 */
export const mapThrownErrors = base.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (err instanceof ORPCError) throw err;
    if (
      err instanceof Error &&
      !PROGRAMMING_ERRORS.some((ctor) => err instanceof ctor)
    ) {
      throw new ORPCError("UNPROCESSABLE_CONTENT", {
        message: err.message,
        cause: err
      });
    }
    throw err;
  }
});
