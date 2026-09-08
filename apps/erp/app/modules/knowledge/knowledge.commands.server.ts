import type { Kysely, KyselyDatabase } from "@carbon/database/client";
import { calendarDateSchema, timestampSchema } from "@carbon/knowledge";
import { sql } from "kysely";
import { z } from "zod";
import { createProcurementDraft as createDraft } from "../purchasing/purchasing.service";

const opaqueId = z.string().trim().min(1).max(256);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const decimal = z.coerce.number().finite().positive();
const nonNegativeDecimal = z.coerce.number().finite().nonnegative();

/** The only wire shape accepted by the Carbon command endpoint.  Actor, company,
 * source, authorization, and auditing are deliberately absent and server-stamped. */
export const procurementDraftCommandValidator = z
  .object({
    idempotencyKey: opaqueId,
    payloadHash: sha256,
    supplierId: opaqueId,
    receivingLocationId: opaqueId,
    requestedArrivalDate: calendarDateSchema.optional(),
    proposedOrderByDate: calendarDateSchema,
    executeAt: timestampSchema.optional(),
    lines: z
      .array(
        z
          .object({
            itemId: opaqueId,
            itemRevisionId: opaqueId,
            quantity: decimal,
            purchaseUnitOfMeasureCode: z.string().trim().min(1).max(32),
            inventoryUnitOfMeasureCode: z.string().trim().min(1).max(32),
            conversionFactor: decimal,
            supplierUnitPrice: nonNegativeDecimal.optional()
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict();

export type ProcurementDraftCommand = z.infer<
  typeof procurementDraftCommandValidator
>;

export type ProcurementCommandContext = {
  companyId: string;
  companyGroupId: string;
  actorId: string;
};

type ScheduleRow = {
  id: string;
  payloadHash: string;
  status: string;
  purchaseOrderId: string | null;
};

async function carbonPurchasingSourceId(
  db: Kysely<KyselyDatabase>,
  companyId: string
) {
  const sources = await sql<{ id: string }>`
    SELECT id FROM knowledge.source
    WHERE "companyId" = ${companyId} AND kind = 'carbon' AND status = 'active'
    ORDER BY id
    LIMIT 2
  `.execute(db);
  if (sources.rows.length !== 1) {
    throw new Error("Exactly one active Carbon purchasing source is required");
  }
  return sources.rows[0]!.id;
}

function procurementInput(command: ProcurementDraftCommand) {
  return {
    idempotencyKey: command.idempotencyKey,
    payloadHash: command.payloadHash,
    supplierId: command.supplierId,
    receivingLocationId: command.receivingLocationId,
    requestedArrivalDate: command.requestedArrivalDate,
    // requestedArrivalDate remains distinct proposal context.  It is never used
    // as an order date; an executable command must state proposedOrderByDate.
    orderDate: command.proposedOrderByDate,
    lines: command.lines
  };
}

/**
 * The canonical command path for both immediate and scheduled procurement.  It
 * only creates Draft purchase orders through the purchasing transaction.
 */
export async function executeProcurementDraftCommand(
  db: Kysely<KyselyDatabase>,
  context: ProcurementCommandContext,
  raw: unknown
) {
  const command = procurementDraftCommandValidator.parse(raw);
  const knowledgeSourceId = await carbonPurchasingSourceId(
    db,
    context.companyId
  );
  return await createDraft(
    db,
    {
      ...context,
      canCreatePurchasing: true,
      knowledgeSourceId
    },
    procurementInput(command)
  );
}

/** Persist a durable reference, never a browser or workforce credential. */
export async function scheduleProcurementDraftCommand(
  db: Kysely<KyselyDatabase>,
  context: ProcurementCommandContext,
  raw: unknown
) {
  const command = procurementDraftCommandValidator.parse(raw);
  if (!command.executeAt) {
    return await executeProcurementDraftCommand(db, context, command);
  }

  const inserted = await sql<ScheduleRow>`
    INSERT INTO public."knowledgeProcurementSchedule" (
      "companyId", "actorId", action, version, payload, "payloadHash",
      "idempotencyKey", "executeAt", "createdBy", "companyGroupId"
    ) VALUES (
      ${context.companyId}, ${context.actorId}, 'carbon.procurement.draft', 1,
      ${JSON.stringify(command)}::jsonb, ${command.payloadHash},
      ${command.idempotencyKey}, ${command.executeAt}::timestamptz, ${context.actorId}, ${context.companyGroupId}
    )
    ON CONFLICT ("companyId", "actorId", action, "idempotencyKey") DO NOTHING
    RETURNING id, "payloadHash", status, "purchaseOrderId"
  `.execute(db);
  const row =
    inserted.rows[0] ??
    (
      await sql<ScheduleRow>`
    SELECT id, "payloadHash", status, "purchaseOrderId"
    FROM public."knowledgeProcurementSchedule"
    WHERE "companyId" = ${context.companyId}
      AND "actorId" = ${context.actorId}
      AND action = 'carbon.procurement.draft'
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
    ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}),
    replayed: inserted.rows.length === 0
  };
}
