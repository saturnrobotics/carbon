// Saturn fork: Carbon's permissions are managed by HQ's authz service (HQ plan
// 0006B). While they are, Carbon's own permission screens are read-only and
// point to HQ; the database lock (migration *_saturn-authz-projection.sql) is
// what actually refuses the writes.

import type { AuthzManagement } from "./types";

export const authzNotManaged: AuthzManagement = {
  managed: false,
  accessUrl: null
};

/**
 * Operations that edit employee types or their permissions, refused through
 * the API and MCP while HQ manages permissions. The upserts also fail at the
 * database lock; refusing them here gives callers the reason up front.
 */
export const authzLockedOperations: ReadonlySet<string> = new Set([
  "users_insertEmployeeType",
  "users_upsertEmployeeType",
  "users_upsertEmployeeTypePermissions",
  "users_deleteEmployeeType"
]);

export function authzManagedMessage(accessUrl: string) {
  return `Carbon permissions are managed in HQ. Change access at ${accessUrl}`;
}

/** Appends the HQ outcome to a flow's message when it skipped a permission step. */
export function withAuthzNotice(message: string, authz: AuthzManagement) {
  return authz.managed
    ? `${message}. ${authzManagedMessage(authz.accessUrl)}`
    : message;
}
