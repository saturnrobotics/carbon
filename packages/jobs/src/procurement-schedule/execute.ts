import { sql } from "kysely";
import type { JobDatabase } from "../db";
import {
  type ClaimedProcurementSchedule,
  runClaimedProcurementSchedule
} from "./core";
import {
  getProcurementScheduleDispatch,
  type ProcurementScheduleDispatch
} from "./dispatcher";

type Schedule = ClaimedProcurementSchedule & {
  version: string | number;
  payload: unknown;
  payloadHash: string;
};

type PermissionCheck = { allowed: boolean; revision: string | null };

async function currentActorCanCreate(
  db: JobDatabase,
  companyId: string,
  actorId: string
): Promise<PermissionCheck> {
  const result = await sql<PermissionCheck>`
    SELECT EXISTS (
      SELECT 1
      FROM public.employee AS employee
      JOIN public."user" AS app_user ON app_user.id = employee.id
      JOIN public."userToCompany" AS membership
        ON membership."userId" = employee.id
       AND membership."companyId" = employee."companyId"
      JOIN public."userPermission" AS permission ON permission.id = employee.id
      WHERE employee."companyId" = ${companyId}
        AND employee.id = ${actorId}
        AND employee.active
        AND app_user.active
        AND membership.role = 'employee'
        AND (
          permission.permissions->'purchasing_create' @> ${JSON.stringify([companyId])}::jsonb
          OR permission.permissions->'purchasing_create' @> '["0"]'::jsonb
        )
    ) AS allowed,
    (SELECT md5(COALESCE(permissions::text, '{}'))
      FROM public."userPermission" WHERE id = ${actorId}) AS revision
  `.execute(db);
  return result.rows[0] ?? { allowed: false, revision: null };
}

async function claim(
  db: JobDatabase,
  scheduleId: string
): Promise<Schedule | undefined> {
  // A bounded lease survives a process crash. Reclaiming can invoke the command
  // again, but the source receipt's SQL uniqueness makes that a replay, not a
  // second PO.
  const result = await sql<Schedule>`
    UPDATE public."knowledgeProcurementSchedule"
    SET status = 'running', "claimedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    WHERE id = ${scheduleId}
      AND "executeAt" <= clock_timestamp()
      AND (
        status = 'scheduled'
        OR (status = 'running' AND "claimedAt" < clock_timestamp() - interval '5 minutes')
      )
    RETURNING id, "companyId", "companyGroupId", "actorId", version, payload, "payloadHash"
  `.execute(db);
  return result.rows[0];
}

export async function executeProcurementSchedule(
  db: JobDatabase,
  scheduleId: string,
  dispatch:
    | ProcurementScheduleDispatch
    | undefined = getProcurementScheduleDispatch()
) {
  if (!dispatch)
    throw new Error("Procurement schedule dispatcher is unavailable");
  const schedule = await claim(db, scheduleId);
  if (!schedule) return { state: "not_due_or_claimed" as const };

  const permission = await currentActorCanCreate(
    db,
    schedule.companyId,
    schedule.actorId
  );
  return await runClaimedProcurementSchedule(
    schedule,
    permission,
    dispatch,
    async (outcome) => {
      await sql`
      UPDATE public."knowledgeProcurementSchedule"
      SET status = ${outcome.state}, "revocationCheckedAt" = clock_timestamp(),
          "revocationVersion" = ${outcome.revision},
          "failureCode" = ${outcome.failureCode ?? null},
          "purchaseOrderId" = ${outcome.purchaseOrderId ?? null}, "updatedAt" = clock_timestamp()
      WHERE id = ${schedule.id} AND status = 'running'
    `.execute(db);
    }
  );
}

export async function dueProcurementSchedules(db: JobDatabase, limit = 100) {
  const result = await sql<{ id: string }>`
    SELECT id FROM public."knowledgeProcurementSchedule"
    WHERE status = 'scheduled' AND "executeAt" <= clock_timestamp()
    ORDER BY "executeAt", id
    LIMIT ${limit}
  `.execute(db);
  return result.rows.map((row) => row.id);
}
