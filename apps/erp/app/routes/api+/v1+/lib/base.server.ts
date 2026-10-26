// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// oRPC context + middleware shared by the HTTP transport and the MCP/agent bridges.

<<<<<<< HEAD
import type { ManifestEntry, ToolPermission } from "@carbon/api";
||||||| 85d9006e1
import type { ManifestEntry, ToolPermission } from "@carbon/api";
=======
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
import type { Permission } from "@carbon/auth";
import type { Database } from "@carbon/database";
<<<<<<< HEAD
import type { PrincipalAssurance } from "@carbon/portal/identity.server";
import { STEP_UP_REQUIRED_CODE } from "@carbon/portal/step-up";
import { ORPCError, os } from "@orpc/server";
||||||| 85d9006e1
import { ORPCError, os } from "@orpc/server";
=======
import { os } from "@orpc/server";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
import type { SupabaseClient } from "@supabase/supabase-js";
<<<<<<< HEAD
import {
  isPortalOperation,
  portalCapabilityFor
} from "~/modules/portal/portal.server";
import {
  prepareOperationWhileAuthzManaged,
  refuseLockedAuthzOperation
} from "~/modules/saturn/saturn.server";
import { isMcpBlockedTool } from "../../mcp+/lib/mcp-blocked-tools";
||||||| 85d9006e1
import { isMcpBlockedTool } from "../../mcp+/lib/mcp-blocked-tools";
=======
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75

/**
 * The identity every Carbon API call runs as. Built once per request (from an API
 * key on HTTP, or from the resolved MCP/agent auth) and injected as oRPC context;
 * `runServiceFn` builds the service context from it.
 */
export interface AuthedContext {
  client: SupabaseClient<Database>;
  userId: string;
  companyId: string;
  companyGroupId: string;
<<<<<<< HEAD
  /** `"api-key"` runs the per-operation scope gate. `"oauth"` (MCP connector) does
   *  not — its RLS/role already bounds it, exactly as MCP behaves today. `"session"`
   *  is an already-authorized in-process caller (the in-app agent behind the route's
   *  requirePermissions, and the workflow engine acting as the workflow's owner) —
   *  not "oauth" because that names a wire protocol, not a trust decision. */
  authKind: "api-key" | "oauth" | "session" | "workforce";
  /** The API key's scopes: `{ "<module>_<action>": [companyId, …] }`. */
||||||| 85d9006e1
  /** `"api-key"` runs the per-operation scope gate. `"oauth"` (MCP connector) does
   *  not — its RLS/role already bounds it, exactly as MCP behaves today. `"session"`
   *  is an already-authorized in-process caller (the in-app agent behind the route's
   *  requirePermissions, and the workflow engine acting as the workflow's owner) —
   *  not "oauth" because that names a wire protocol, not a trust decision. */
  authKind: "api-key" | "oauth" | "session";
  /** The API key's scopes: `{ "<module>_<action>": [companyId, …] }`. */
=======
  /** How the caller authenticated. Every kind is checked by the service
   *  function's own gate (`runServiceFn` builds an entry context): RLS alone
   *  does not bound a caller, because a service function may write through the
   *  direct connection, which bypasses it. `"session"` is an in-process caller
   *  acting as a user (the workflow engine acting as the workflow's owner) —
   *  not "oauth" because that names a wire protocol. */
  authKind: "api-key" | "oauth" | "session";
  /** `{ "<module>_<action>": [companyId, …] }` — the API key's scopes, or for a
   *  user (OAuth, a workflow's owner) the user's own permissions in the company
   *  (`scopesFromPermissions`). */
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
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
 * A user's permissions (`getUserClaims().permissions`: module → action → company
 * ids) as the scope map the gate reads, holding only `companyId`. The OAuth
 * caller's scopes, so a connector token can do exactly what its user can do in
 * the token's company — no more.
 */
export function scopesFromPermissions(
  permissions: Record<string, Permission>,
  companyId: string
): Record<string, string[]> {
  const scopes: Record<string, string[]> = {};
  for (const [module, actions] of Object.entries(permissions)) {
    for (const [action, companyIds] of Object.entries(actions)) {
      if (companyIds.includes(companyId)) {
        scopes[`${module}_${action}`] = [companyId];
      }
    }
  }
  return scopes;
}
<<<<<<< HEAD

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
  base.middleware(async ({ context, next }, input) => {
    if (isMcpBlockedTool(meta.name)) throw new ORPCError("NOT_FOUND");
    await refuseLockedAuthzOperation(meta.name);
    if (isPortalOperation(meta) && context.authKind !== "workforce") {
      throw new ORPCError("NOT_FOUND");
    }
    if (context.authKind === "api-key") {
      assertScopes(context.scopes, context.companyId, meta.permission);
    } else if (context.authKind === "workforce") {
      assertWorkforceAuthorization(context, meta);
    }
    await prepareOperationWhileAuthzManaged(
      meta.name,
      context.companyId,
      input
    );
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
||||||| 85d9006e1

/** Per-operation gate middleware — runs the scope check for API-key callers.
 *  The blocked-name guard is belt-and-braces: blocked tools are already excluded
 *  from the manifest at generation time, so this only fires if that exclusion
 *  ever regresses — the surface stays closed instead of silently opening. */
export const gate = (meta: ManifestEntry) =>
  base.middleware(async ({ context, next }) => {
    if (isMcpBlockedTool(meta.name)) throw new ORPCError("NOT_FOUND");
    if (context.authKind === "api-key") {
      assertScopes(context.scopes, context.companyId, meta.permission);
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
=======
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
