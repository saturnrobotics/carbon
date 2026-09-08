import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import {
  procurementDraftCommandValidator,
  scheduleProcurementDraftCommand
} from "./knowledge.commands.server";

/**
 * Generated as `knowledge_createProcurementDraft`.  Workforce authorization is
 * enforced by the API operation gate; scheduled execution independently
 * rechecks the same current user state before it reaches this function.
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
    procurementDraftCommandValidator.parse(args)
  );
}
