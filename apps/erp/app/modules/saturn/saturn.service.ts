import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { getLogger } from "@carbon/logger";
import { sql } from "kysely";
import { getDatabaseClient } from "~/services/database.server";
import { authzNotManaged } from "./saturn.models";
import type { AuthzManagement } from "./types";

const logger = getLogger("erp", "saturn-authz");

/** Whether HQ manages Carbon's permissions, and where to change them. */
export async function getAuthzManagement(
  db: Kysely<KyselyDatabase> = getDatabaseClient()
): Promise<AuthzManagement> {
  try {
    const { rows } = await sql<{
      enabled: boolean;
      access_url: string | null;
    }>`SELECT enabled, access_url FROM carbon_private.authz_projection_status()`.execute(
      db
    );
    const status = rows[0];
    return status?.enabled && status.access_url
      ? { managed: true, accessUrl: status.access_url }
      : authzNotManaged;
  } catch (e) {
    // Display only: the database lock refuses permission writes either way.
    logger.error("Failed to read whether HQ manages permissions", {
      error: e
    });
    return authzNotManaged;
  }
}

/**
 * The company's system employee type, created with no template permissions if
 * missing. While HQ manages permissions the lock refuses every other employeeType
 * write, but employee."employeeTypeId" is NOT NULL, so membership still needs a
 * type (migration *_saturn-authz-membership-only.sql).
 */
export async function ensureSystemEmployeeType(
  db: Kysely<KyselyDatabase>,
  companyId: string,
  systemType: "Admin" | "Console Operator"
): Promise<string> {
  const { rows } = await sql<{
    id: string | null;
  }>`SELECT carbon_private.authz_ensure_system_employee_type(${companyId}, ${systemType}) AS id`.execute(
    db
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`Failed to ensure the ${systemType} employee type`);
  return id;
}
