import { z } from "zod";
import {
  calendarDateSchema,
  nonNegativeDecimalSchema,
  positiveDecimalSchema,
  timestampSchema,
  timezoneSchema
} from "../contracts";

export const procurementDraftProposalSchema = z
  .object({
    id: z.string().min(1).max(256),
    version: z.literal(1),
    action: z.literal("carbon.procurement.draft"),
    idempotencyKey: z.string().min(1).max(256),
    supplierId: z.string().min(1).max(256),
    receivingLocationId: z.string().min(1).max(256),
    requestedArrivalDate: calendarDateSchema.optional(),
    proposedOrderByDate: calendarDateSchema.optional(),
    executeAt: timestampSchema.optional(),
    businessTimezone: timezoneSchema,
    lines: z
      .array(
        z
          .object({
            itemId: z.string().min(1).max(256),
            itemRevisionId: z.string().min(1).max(256),
            quantity: positiveDecimalSchema,
            purchaseUnitOfMeasureCode: z.string().min(1).max(32),
            inventoryUnitOfMeasureCode: z.string().min(1).max(32),
            conversionFactor: positiveDecimalSchema,
            supplierUnitPrice: nonNegativeDecimalSchema.optional()
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict();
export type ProcurementDraftProposal = z.infer<
  typeof procurementDraftProposalSchema
>;
