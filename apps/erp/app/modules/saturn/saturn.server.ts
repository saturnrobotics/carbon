import type { Result } from "@carbon/auth";
import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { getLogger } from "@carbon/logger";
import { ORPCError } from "@orpc/server";
import { sql } from "kysely";
import { redirect } from "react-router";
import { getDatabaseClient } from "~/services/database.server";
import {
  type AuthzManagement,
  authzLockedOperations,
  authzManagedMessage,
  authzNotManaged
} from "./saturn.models";

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

/** Ends a permission-editing action while HQ manages permissions. */
export async function refuseWhileAuthzManaged(
  request: Request,
  redirectTo: string
) {
  const authz = await getAuthzManagement();
  if (authz.managed) {
    // Loaded on use: the API gate imports this module, and the session stack
    // does not belong in its module graph.
    const { flash } = await import("@carbon/auth/session.server");
    const refused: Result = {
      success: false,
      message: authzManagedMessage(authz.accessUrl)
    };
    throw redirect(redirectTo, await flash(request, refused));
  }
}

/** Refuses an API or MCP operation that edits permissions while HQ manages them. */
export async function refuseLockedAuthzOperation(name: string) {
  if (!authzLockedOperations.has(name)) return;
  const authz = await getAuthzManagement();
  if (authz.managed) {
    throw new ORPCError("FORBIDDEN", {
      message: authzManagedMessage(authz.accessUrl)
    });
  }
}
