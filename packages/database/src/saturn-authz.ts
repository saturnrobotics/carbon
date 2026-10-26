// Saturn fork (HQ plan 0006B B7): while HQ's authz service manages Carbon's
// permissions, edge functions that create membership write membership only.
// The database lock (migrations *_saturn-authz-projection.sql and
// *_saturn-authz-membership-only.sql) refuses any other permission write; these
// helpers let a flow skip its permission step instead of failing on the lock.
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";

export type PermissionsManagement =
  | { managed: false; accessUrl: null }
  | { managed: true; accessUrl: string };

type Executor = Kysely<any> | Transaction<any>;

/** Whether HQ manages Carbon's permissions, and where to change them. The lock
 *  is on exactly when `enabled` is, and enabling requires HQ's origin. */
export function permissionsManagementFrom(
  row: { enabled: boolean; access_url: string | null } | undefined
): PermissionsManagement {
  return row?.enabled
    ? { managed: true, accessUrl: row.access_url ?? "" }
    : { managed: false, accessUrl: null };
}

/** Reads the lock's state with the caller's connection (postgres). A failed read
 *  fails the flow: guessing "not managed" would only hit the lock later. */
export async function getPermissionsManagement(
  db: Executor
): Promise<PermissionsManagement> {
  const { rows } = await sql<{ enabled: boolean; access_url: string | null }>`
    SELECT enabled, access_url FROM carbon_private.authz_projection_status()
  `.execute(db);
  return permissionsManagementFrom(rows[0]);
}

/** The company's system employee type, created without template permissions if
 *  missing: membership (employee) needs a type, and a type grants nothing. */
export async function ensureSystemEmployeeType(
  db: Executor,
  companyId: string,
  systemType: "Admin" | "Console Operator"
): Promise<string> {
  const { rows } = await sql<{ id: string | null }>`
    SELECT carbon_private.authz_ensure_system_employee_type(${companyId}, ${systemType}) AS id
  `.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new Error(`Failed to ensure the ${systemType} employee type`);
  return id;
}

/** The outcome a flow reports when it skipped its permission step. */
export function managedInHqMessage(accessUrl: string): string {
  return `Carbon permissions are managed in HQ. Change access at ${accessUrl}`;
}
