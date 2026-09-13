import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { calendarDateSchema, timestampSchema } from "@carbon/portal";
import { procurementCommandPayloadHash } from "@carbon/portal/commands/procurement";
import { datetime } from "@carbon/utils";
import { parseAbsolute } from "@internationalized/date";
import { sql } from "kysely";
import { z } from "zod";
import {
  PROCUREMENT_DRAFT_PAYLOAD_VERSION,
  type ProcurementDraftInput
} from "../purchasing/purchasing.models";
import {
  createProcurementDraft as createDraft,
  resolveProcurementDraft
} from "../purchasing/purchasing.service";

const opaqueId = z.string().trim().min(1).max(256);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
// Decimals stay strings on the wire: what is hashed, stored for a scheduled run
// and replayed later must be byte-identical, and a float would not be.
const decimal = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,27})(?:\.\d{1,5})?$/,
    "Expected a decimal with at most 5 places"
  );
const positiveDecimal = decimal.refine(
  (value) => Number(value) > 0,
  "Expected a positive decimal"
);

/** The scheduled-command payload version this receiver can execute. Owned by the
 * purchasing contract the command is built against, so the receipt, the schedule
 * row and the validator can never claim different versions of the same payload. */
export const PROCUREMENT_COMMAND_VERSION = PROCUREMENT_DRAFT_PAYLOAD_VERSION;
export const PROCUREMENT_COMMAND_ACTION = "carbon.procurement.draft";

/** The only wire shape accepted by the Carbon command endpoint. Actor, company,
 * authorization and auditing are deliberately absent and server-stamped. */
export const procurementDraftCommandValidator = z
  .object({
    idempotencyKey: opaqueId,
    payloadHash: sha256,
    supplierId: opaqueId,
    receivingLocationId: opaqueId,
    requestedArrivalDate: calendarDateSchema.optional(),
    proposedOrderByDate: calendarDateSchema.optional(),
    executeAt: timestampSchema.optional(),
    lines: z
      .array(
        z
          .object({
            itemId: opaqueId,
            itemRevisionId: opaqueId,
            quantity: positiveDecimal,
            purchaseUnitOfMeasureCode: z.string().trim().min(1).max(32),
            inventoryUnitOfMeasureCode: z.string().trim().min(1).max(32),
            conversionFactor: positiveDecimal,
            supplierUnitPrice: decimal.optional()
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict()
  .refine(
    (command) =>
      !command.requestedArrivalDate ||
      !command.proposedOrderByDate ||
      command.requestedArrivalDate >= command.proposedOrderByDate,
    {
      path: ["requestedArrivalDate"],
      message: "Requested arrival cannot precede the proposed order date"
    }
  )
  // The hash binds the idempotency key to this exact business content. It is
  // recomputed here, so a stored or forwarded command whose payload drifted
  // from its hash is refused rather than executed.
  .refine(
    (command) =>
      procurementCommandPayloadHash({
        supplierId: command.supplierId,
        receivingLocationId: command.receivingLocationId,
        requestedArrivalDate: command.requestedArrivalDate,
        proposedOrderByDate: command.proposedOrderByDate,
        lines: command.lines
      }) === command.payloadHash,
    {
      path: ["payloadHash"],
      message: "Payload hash does not match the payload"
    }
  );

export type ProcurementDraftCommand = z.infer<
  typeof procurementDraftCommandValidator
>;

export type ProcurementCommandContext = {
  companyId: string;
  companyGroupId: string;
  actorId: string;
};

export type ProcurementCommandResult =
  | { purchaseOrderId: string; replayed: boolean }
  | {
      scheduleId: string;
      status: string;
      executeAt: string;
      purchaseOrderId?: string;
      replayed: boolean;
    };

type ScheduleRow = {
  id: string;
  payloadHash: string;
  status: string;
  purchaseOrderId: string | null;
  executeAt: string;
};

/**
 * Whether the actor may create purchasing documents in this company RIGHT NOW:
 * an active user, an active employee of the company, and an explicit
 * `purchasing_create` grant for it. The same rule as
 * `get_companies_with_employee_permission`, evaluated for a named user instead
 * of `auth.uid()` — the global "0" wildcard no longer exists.
 */
export async function actorCanCreatePurchasing(
  db: Kysely<KyselyDatabase>,
  companyId: string,
  actorId: string
): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`
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
        AND permission.permissions->'purchasing_create' @> ${JSON.stringify([companyId])}::jsonb
    ) AS allowed
  `.execute(db);
  return result.rows[0]?.allowed === true;
}

/** The purchasing service's input: numbers at the ERP boundary, strings before it. */
function procurementInput(
  command: ProcurementDraftCommand
): ProcurementDraftInput {
  return {
    idempotencyKey: command.idempotencyKey,
    payloadHash: command.payloadHash,
    supplierId: command.supplierId,
    receivingLocationId: command.receivingLocationId,
    // requestedArrivalDate is receiving context and never becomes the order
    // date; an absent proposedOrderByDate means today on the company calendar.
    orderDate: command.proposedOrderByDate,
    requestedArrivalDate: command.requestedArrivalDate,
    lines: command.lines.map((line) => ({
      itemId: line.itemId,
      itemRevisionId: line.itemRevisionId,
      quantity: Number(line.quantity),
      purchaseUnitOfMeasureCode: line.purchaseUnitOfMeasureCode,
      inventoryUnitOfMeasureCode: line.inventoryUnitOfMeasureCode,
      conversionFactor: Number(line.conversionFactor),
      supplierUnitPrice:
        line.supplierUnitPrice === undefined
          ? undefined
          : Number(line.supplierUnitPrice)
    }))
  };
}

async function authorizedContext(
  db: Kysely<KyselyDatabase>,
  context: ProcurementCommandContext
) {
  return {
    ...context,
    canCreatePurchasing: await actorCanCreatePurchasing(
      db,
      context.companyId,
      context.actorId
    )
  };
}

/**
 * When a durable schedule owns this command, it decides whether the command may
 * still run. The proposal the schedule stored is the approved one: a different
 * payload under the same key, a payload version this build cannot execute, or a
 * cancelled row all stop execution here. A schedule the worker has not claimed
 * is not executable either — that is what keeps the command from running early
 * through the immediate path.
 */
async function assertScheduleStillExecutable(
  db: Kysely<KyselyDatabase>,
  context: ProcurementCommandContext,
  command: ProcurementDraftCommand
): Promise<void> {
  const schedule = await sql<{
    version: number;
    payloadHash: string;
    status: string;
  }>`
    SELECT version, "payloadHash", status
    FROM public."portalProcurementSchedule"
    WHERE "companyId" = ${context.companyId}
      AND "actorId" = ${context.actorId}
      AND action = ${PROCUREMENT_COMMAND_ACTION}
      AND "idempotencyKey" = ${command.idempotencyKey}
  `.execute(db);
  const row = schedule.rows[0];
  if (!row) return;
  if (Number(row.version) !== PROCUREMENT_COMMAND_VERSION) {
    throw new Error(
      `Scheduled procurement payload version ${row.version} is not executable`
    );
  }
  if (row.payloadHash !== command.payloadHash) {
    throw new Error("Scheduled procurement proposal has changed");
  }
  if (row.status === "cancelled" || row.status === "failed") {
    throw new Error(`Scheduled procurement command is ${row.status}`);
  }
  if (row.status === "scheduled") {
    throw new Error("Scheduled procurement command is not due yet");
  }
}

/**
 * The canonical command path — the ONE way a procurement command becomes a
 * Draft purchase order, whether it arrived from the API now or from the jobs
 * worker when its moment came. It re-validates the payload against its hash,
 * rechecks the actor's CURRENT purchasing permission, re-checks any durable
 * schedule that owns the command, and hands the rest to the purchasing
 * transaction, which re-verifies supplier, location and item revision.
 */
export async function executeProcurementDraftCommand(
  db: Kysely<KyselyDatabase>,
  context: ProcurementCommandContext,
  raw: unknown
): Promise<{ purchaseOrderId: string; replayed: boolean }> {
  const command = procurementDraftCommandValidator.parse(raw);
  await assertScheduleStillExecutable(db, context, command);
  return await createDraft(
    db,
    await authorizedContext(db, context),
    procurementInput(command)
  );
}

/** Is the command's moment already here? Instants compare without a timezone. */
function isDue(executeAt: string): boolean {
  return (
    parseAbsolute(executeAt, "UTC").compare(
      parseAbsolute(datetime.timestamp(), "UTC")
    ) <= 0
  );
}

/**
 * Create the Draft now, or persist a durable command reference for later. A
 * scheduled row carries the validated command and the actor's id — never a
 * credential — and the worker rechecks everything at execution time. The
 * proposal is preflighted against Carbon before it is accepted, so a missing
 * supplier, location or item revision is refused while the person is still
 * there to fix it rather than at three in the morning.
 */
export async function scheduleProcurementDraftCommand(
  db: Kysely<KyselyDatabase>,
  context: ProcurementCommandContext,
  raw: unknown
): Promise<ProcurementCommandResult> {
  const command = procurementDraftCommandValidator.parse(raw);
  if (!command.executeAt || isDue(command.executeAt)) {
    return await executeProcurementDraftCommand(db, context, command);
  }

  const authorized = await authorizedContext(db, context);
  if (!authorized.canCreatePurchasing) {
    throw new Error("Purchasing create permission is required");
  }
  await resolveProcurementDraft(db, authorized, procurementInput(command));

  const inserted = await sql<ScheduleRow>`
    INSERT INTO public."portalProcurementSchedule" (
      "companyId", "actorId", action, version, payload, "payloadHash",
      "idempotencyKey", "executeAt", "createdBy", "companyGroupId"
    ) VALUES (
      ${context.companyId}, ${context.actorId}, ${PROCUREMENT_COMMAND_ACTION},
      ${PROCUREMENT_COMMAND_VERSION}, ${JSON.stringify(command)}::jsonb,
      ${command.payloadHash}, ${command.idempotencyKey},
      ${command.executeAt}::timestamptz, ${context.actorId}, ${context.companyGroupId}
    )
    ON CONFLICT ("companyId", "actorId", action, "idempotencyKey") DO NOTHING
    RETURNING id, "payloadHash", status, "purchaseOrderId", "executeAt"::text AS "executeAt"
  `.execute(db);
  const row =
    inserted.rows[0] ??
    (
      await sql<ScheduleRow>`
        SELECT id, "payloadHash", status, "purchaseOrderId", "executeAt"::text AS "executeAt"
        FROM public."portalProcurementSchedule"
        WHERE "companyId" = ${context.companyId}
          AND "actorId" = ${context.actorId}
          AND action = ${PROCUREMENT_COMMAND_ACTION}
          AND "idempotencyKey" = ${command.idempotencyKey}
      `.execute(db)
    ).rows[0];
  if (!row) throw new Error("Could not persist procurement schedule");
  if (row.payloadHash !== command.payloadHash) {
    throw new Error("Idempotency key was reused with a different payload");
  }
  return {
    scheduleId: row.id,
    status: row.status,
    executeAt: row.executeAt,
    ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}),
    replayed: inserted.rows.length === 0
  };
}
