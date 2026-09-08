import { z } from "zod";

export const knowledgeItemSearch = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N} ._/-]+$/u);
export const knowledgePageLimit = z.number().int().min(1).max(50);
export const knowledgeIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._/-]+$/);

export const resolveItemsValidator = z
  .object({
    search: knowledgeItemSearch,
    limit: knowledgePageLimit.optional()
  })
  .strict();

export const getRecentReceiptsValidator = z
  .object({
    limit: knowledgePageLimit.optional()
  })
  .strict();

export const getRecentReceiptItemsValidator = z
  .object({
    itemIds: z.array(knowledgeIdentifier).min(1).max(50).optional(),
    limit: knowledgePageLimit.optional()
  })
  .strict();

export const getItemIdentityValidator = z
  .object({ itemId: knowledgeIdentifier })
  .strict();
export const getDocumentReferencesValidator = z
  .object({
    itemId: knowledgeIdentifier
  })
  .strict();
export const getPurchaseStatusValidator = z
  .object({
    purchaseOrderId: knowledgeIdentifier
  })
  .strict();
