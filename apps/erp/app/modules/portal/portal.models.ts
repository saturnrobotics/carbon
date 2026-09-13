import { z } from "zod";

export const portalItemSearch = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N} ._/-]+$/u);
export const portalPageLimit = z.number().int().min(1).max(50);
export const portalIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._/-]+$/);

export const resolveItemsValidator = z
  .object({
    search: portalItemSearch,
    limit: portalPageLimit.optional()
  })
  .strict();

export const getRecentReceiptsValidator = z
  .object({
    limit: portalPageLimit.optional()
  })
  .strict();

export const getRecentReceiptItemsValidator = z
  .object({
    itemIds: z.array(portalIdentifier).min(1).max(50).optional(),
    limit: portalPageLimit.optional()
  })
  .strict();

export const getItemIdentityValidator = z
  .object({ itemId: portalIdentifier })
  .strict();
export const getDocumentReferencesValidator = z
  .object({
    itemId: portalIdentifier
  })
  .strict();
export const getItemSupplierPricingValidator = z
  .object({
    itemId: portalIdentifier,
    supplierId: portalIdentifier.optional()
  })
  .strict();
export const getPurchaseStatusValidator = z
  .object({
    purchaseOrderId: portalIdentifier
  })
  .strict();
