import type { Result } from "@carbon/auth";
import { ORPCError } from "@orpc/server";
import { redirect } from "react-router";
import { authzLockedOperations, authzManagedMessage } from "./saturn.models";
import { getAuthzManagement } from "./saturn.service";

// Routes import the read from here with the guards (one import per route).
export { getAuthzManagement };

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
