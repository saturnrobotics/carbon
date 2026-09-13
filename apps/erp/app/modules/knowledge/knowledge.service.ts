import type { Database } from "@carbon/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  knowledgeIdentifier,
  knowledgeItemSearch,
  knowledgePageLimit
} from "./knowledge.models";
import {
  type ReceiptLineRead,
  summarizeReceiptIdentities,
  type TrackedEntityRead
} from "./knowledge.receipts";

const ITEM_IDENTITY_FIELDS =
  "id,readableId,readableIdWithRevision,name,description,type,revision,revisionStatus,mpn,unitOfMeasureCode,active,updatedAt" as const;
const RECEIPT_FIELDS =
  "id,receiptId,postingDate,sourceDocument,sourceDocumentId,sourceDocumentReadableId,status,supplierId,locationId,updatedAt" as const;
const PURCHASE_STATUS_FIELDS =
  "id,purchaseOrderId,revisionId,status,orderDate,supplierId,supplierReference,closedAt,updatedAt" as const;

/** Resolve a small, safe item projection; cost and price fields are excluded. */
export async function resolveItems(
  client: SupabaseClient<Database>,
  companyId: string,
  search: string,
  limit = 20
) {
  const term = knowledgeItemSearch.parse(search);
  const boundedLimit = knowledgePageLimit.parse(limit);
  return await client
    .from("item")
    .select(ITEM_IDENTITY_FIELDS)
    .eq("companyId", companyId)
    .eq("active", true)
    .or(`readableId.ilike.%${term}%,name.ilike.%${term}%,mpn.ilike.%${term}%`)
    .order("readableId", { ascending: true })
    .limit(boundedLimit);
}

/** Return one company-scoped item identity and revision projection. */
export async function getItemIdentity(
  client: SupabaseClient<Database>,
  itemId: string,
  companyId: string
) {
  return await client
    .from("item")
    .select(ITEM_IDENTITY_FIELDS)
    .eq("companyId", companyId)
    .eq("id", knowledgeIdentifier.parse(itemId))
    .maybeSingle();
}

/** List recent posted receipts only; draft and void receiving is excluded. */
export async function getRecentReceipts(
  client: SupabaseClient<Database>,
  companyId: string,
  limit = 20
) {
  return await client
    .from("receipt")
    .select(RECEIPT_FIELDS)
    .eq("companyId", companyId)
    .eq("status", "Posted")
    .not("postingDate", "is", null)
    .order("postingDate", { ascending: false })
    .limit(knowledgePageLimit.parse(limit));
}

/**
 * Return bounded, posted receipt line identities.
 *
 * Two batched reads over a bounded candidate set; no row triggers a query. The
 * inventory ledger is deliberately NOT one of them. `post-receipt` writes its
 * `itemLedger` rows in the same transaction as the `status: "Posted"` flip, so
 * the posted status this read already filters on IS the posting evidence — and
 * a purchase receipt's ledger rows carry no `documentLineId` at all (only
 * material issuing sets that column), so keying on the line found nothing for a
 * genuinely posted receipt. Both facts the ledger would have supplied are on
 * the line itself: `receivedQuantity` is the number the ledger is derived from,
 * and the lot or serial is the tracked entity that names this receipt line —
 * the same join `post-receipt` uses to stamp `itemLedger.trackedEntityId`.
 */
export async function getRecentReceiptItems(
  client: SupabaseClient<Database>,
  companyId: string,
  itemIds?: string[],
  limit = 20
) {
  const boundedLimit = knowledgePageLimit.parse(limit);
  const validatedItemIds = itemIds
    ? z.array(knowledgeIdentifier).min(1).max(50).parse(itemIds)
    : undefined;
  let linesQuery = client
    .from("receiptLine")
    .select(
      "id,itemId,receivedQuantity,requiresBatchTracking,requiresSerialTracking,receipt!inner(id,postingDate,status),item!inner(revision,mpn)"
    )
    .eq("companyId", companyId)
    .eq("receipt.companyId", companyId)
    .eq("receipt.status", "Posted")
    .not("receipt.postingDate", "is", null)
    .order("createdAt", { ascending: false })
    .limit(boundedLimit + 1);
  if (validatedItemIds) linesQuery = linesQuery.in("itemId", validatedItemIds);
  const linesResult = await linesQuery;
  if (linesResult.error) return { data: null, error: linesResult.error };
  const truncatedLines = (linesResult.data?.length ?? 0) > boundedLimit;
  const lines = (linesResult.data ?? []).slice(
    0,
    boundedLimit
  ) as ReceiptLineRead[];
  if (lines.length === 0) {
    return {
      data: { items: [], status: "complete" as const },
      error: null
    };
  }

  const lineIds = lines.map((line) => line.id);
  const trackedResult = await client
    .from("trackedEntity")
    .select("id,readableId,attributes")
    .eq("companyId", companyId)
    .in("attributes ->> Receipt Line", lineIds)
    .limit(101);
  if (trackedResult.error) return { data: null, error: trackedResult.error };
  const truncatedTracking = (trackedResult.data?.length ?? 0) > 100;
  const summary = summarizeReceiptIdentities(
    lines,
    (trackedResult.data ?? []).slice(0, 100) as TrackedEntityRead[]
  );
  const truncated =
    truncatedLines || truncatedTracking || summary.items.length > 100;
  const partial = truncated || summary.incompleteReasons.length > 0;
  return {
    data: {
      items: summary.items.slice(0, 100),
      status: partial ? ("partial" as const) : ("complete" as const),
      ...(partial
        ? {
            incompleteReason: [
              ...(truncated ? ["bounded-result-truncated"] : []),
              ...summary.incompleteReasons
            ].join(",")
          }
        : {})
    },
    error: null
  };
}

/** List item document object references without minting public URLs. */
export async function getDocumentReferences(
  client: SupabaseClient<Database>,
  itemId: string,
  companyId: string
) {
  const prefix = `${companyId}/parts/${knowledgeIdentifier.parse(itemId)}`;
  const result = await client.storage.from("private").list(prefix, {
    limit: 50,
    sortBy: { column: "name", order: "asc" }
  });
  return {
    data:
      result.data?.map((file) => ({
        name: file.name,
        objectKey: `${prefix}/${file.name}`,
        updatedAt: file.updated_at
      })) ?? null,
    error: result.error
  };
}

/**
 * Return the active supplier unit prices for one item. This is the only
 * knowledge read that discloses money: it is a separate operation with its own
 * capability (`knowledge.read.pricing`) and gates on purchasing view, so the
 * identity reads can keep excluding every price and cost field. Two batched
 * reads, both under the caller's own RLS; the supplier read is what supplies the
 * currency, and a supplier the caller may not see reports no currency.
 */
export async function getItemSupplierPricing(
  client: SupabaseClient<Database>,
  itemId: string,
  companyId: string,
  supplierId?: string
) {
  let partsQuery = client
    .from("supplierPart")
    .select("supplierId,unitPrice,supplierUnitOfMeasureCode,updatedAt")
    .eq("companyId", companyId)
    .eq("itemId", knowledgeIdentifier.parse(itemId))
    .eq("active", true)
    .order("updatedAt", { ascending: false, nullsFirst: false })
    .limit(50);
  if (supplierId) {
    partsQuery = partsQuery.eq(
      "supplierId",
      knowledgeIdentifier.parse(supplierId)
    );
  }
  const parts = await partsQuery;
  if (parts.error) return { data: null, error: parts.error };
  const rows = parts.data ?? [];
  const supplierIds = [...new Set(rows.map((row) => row.supplierId))];
  const suppliers = supplierIds.length
    ? await client
        .from("supplier")
        .select("id,currencyCode")
        .eq("companyId", companyId)
        .in("id", supplierIds)
    : { data: [], error: null };
  if (suppliers.error) return { data: null, error: suppliers.error };
  const currencyBySupplier = new Map(
    (suppliers.data ?? []).map((supplier) => [
      supplier.id,
      supplier.currencyCode
    ])
  );
  return {
    data: rows.map((row) => ({
      supplierId: row.supplierId,
      supplierUnitPrice: row.unitPrice,
      currencyCode: currencyBySupplier.get(row.supplierId) ?? null,
      unitOfMeasureCode: row.supplierUnitOfMeasureCode,
      updatedAt: row.updatedAt
    })),
    error: null
  };
}

/** Return one bounded purchase-order status projection; financial fields stay out. */
export async function getPurchaseStatus(
  client: SupabaseClient<Database>,
  purchaseOrderId: string,
  companyId: string
) {
  return await client
    .from("purchaseOrder")
    .select(PURCHASE_STATUS_FIELDS)
    .eq("companyId", companyId)
    .or(
      `id.eq.${knowledgeIdentifier.parse(purchaseOrderId)},purchaseOrderId.eq.${knowledgeIdentifier.parse(purchaseOrderId)}`
    )
    .maybeSingle();
}
