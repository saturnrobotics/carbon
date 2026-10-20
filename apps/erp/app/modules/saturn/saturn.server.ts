import type { Result } from "@carbon/auth";
import { ORPCError } from "@orpc/server";
import { redirect } from "react-router";
import { getDatabaseClient } from "~/services/database.server";
import {
  authzLockedOperations,
  authzManagedMessage,
  authzNotManaged,
  withAuthzNotice
} from "./saturn.models";
import { ensureSystemEmployeeType, getAuthzManagement } from "./saturn.service";
import type { AuthzManagement } from "./types";

// Routes import the read from here with the guards (one import per route).
export { getAuthzManagement, withAuthzNotice };

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

/**
 * Console mode while HQ manages permissions. Enabling it needs the company's
 * "Console Operator" employee type, which operators are created with; upstream's
 * service would insert it with template permissions, which the lock refuses.
 * Creating it here first, without a template, means the service finds it and
 * writes neither. Returns the HQ state when enabling, so the caller can say
 * where operator access is managed; otherwise "not managed", and nothing is read.
 */
export async function prepareConsoleMode(
  companyId: string,
  enabled: boolean
): Promise<AuthzManagement> {
  if (!enabled) return authzNotManaged;
  const authz = await getAuthzManagement();
  if (authz.managed) {
    await ensureSystemEmployeeType(
      getDatabaseClient(),
      companyId,
      "Console Operator"
    );
  }
  return authz;
}

/**
 * The API gate's second hook, run for every MCP, agent and /api/v1 operation
 * once the caller is authorized for it: prepares console mode for
 * settings_updateConsoleSetting (see prepareConsoleMode). Other operations read
 * nothing.
 */
export async function prepareOperationWhileAuthzManaged(
  name: string,
  companyId: string,
  input: unknown
) {
  if (name === "settings_updateConsoleSetting") {
    const consoleEnabled =
      typeof input === "object" &&
      input !== null &&
      (input as { consoleEnabled?: unknown }).consoleEnabled === true;
    await prepareConsoleMode(companyId, consoleEnabled);
  }
}
