import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { scheduleProcurementDraftCommand } from "./portal.commands.server";

/**
 * Generated as `portal_createProcurementDraft`.  Workforce authorization is
 * enforced by the API operation gate; the command boundary rechecks the actor's
 * current purchasing permission, and a scheduled execution rechecks the same
 * state again before it reaches the purchasing transaction. The raw arguments
 * are handed through unchanged so the payload hash is verified over exactly
 * what the caller sent.
 */
export async function createProcurementDraft(
  db: Kysely<KyselyDatabase>,
  args: unknown,
  userId: string,
  companyId: string,
  companyGroupId: string
) {
  return await scheduleProcurementDraftCommand(
    db,
    { actorId: userId, companyId, companyGroupId },
    args
  );
}
