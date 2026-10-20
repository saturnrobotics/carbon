// Saturn fork (HQ plan 0006B B7): while HQ's authz service manages Carbon's
// permissions, flows that change membership (deactivation here, SSO provisioning
// in @carbon/ee) write membership only. userPermission then holds HQ's projection,
// which the database lock (migration *_saturn-authz-projection.sql) lets nothing
// else change; these helpers let a flow skip its permission step and say so,
// instead of failing on the lock. While the projection is off nothing changes.
import { getPostgresConnectionPool } from "@carbon/database/client";
import { getLogger } from "@carbon/logger";

const log = getLogger("auth", "saturn-authz");

export type PermissionsManagement =
  | { managed: false; accessUrl: null }
  | { managed: true; accessUrl: string };

export const permissionsNotManaged: PermissionsManagement = {
  managed: false,
  accessUrl: null
};

/**
 * Whether HQ manages Carbon's permissions, and where to change them. Read with
 * the apps' own connection (postgres), the only one carbon_private allows.
 *
 * A failed read answers "not managed": the flow then runs as upstream does, and
 * if the lock is on the database still refuses its permission write.
 */
export async function getPermissionsManagement(): Promise<PermissionsManagement> {
  try {
    const { rows } = await getPostgresConnectionPool(1).query<{
      enabled: boolean;
      access_url: string | null;
    }>(
      "SELECT enabled, access_url FROM carbon_private.authz_projection_status()"
    );
    const status = rows[0];
    return status?.enabled
      ? { managed: true, accessUrl: status.access_url ?? "" }
      : permissionsNotManaged;
  } catch (e) {
    log.error("Failed to read whether HQ manages permissions", { error: e });
    return permissionsNotManaged;
  }
}

/** The outcome a flow reports when it skipped its permission step. */
export function managedInHqMessage(accessUrl: string) {
  return `Carbon permissions are managed in HQ. Change access at ${accessUrl}`;
}

/** Appends the HQ outcome to a flow's message while HQ manages permissions. */
export function withPermissionsNotice(
  message: string,
  authz: PermissionsManagement
) {
  return authz.managed
    ? `${message}. ${managedInHqMessage(authz.accessUrl)}`
    : message;
}

/**
 * Stands in for a userPermission write while HQ manages permissions, so a flow
 * reads `authz.skippedWrite ?? <upstream write>` and the write is never sent.
 * Undefined while Carbon manages its own permissions.
 */
export function skippedPermissionWrite(authz: PermissionsManagement) {
  return authz.managed
    ? Promise.resolve({ data: null, error: null } as const)
    : undefined;
}
