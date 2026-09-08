import type { Database } from "@carbon/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  knowledgeIdentifier,
  knowledgeItemSearch,
  knowledgePageLimit
} from "./knowledge.models";
import {
  type LedgerRead,
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
 * Return bounded, posted line identities with net ledger reversals. The three
 * reads are batched across the bounded candidate set; no row triggers a query.
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
      "id,itemId,requiresBatchTracking,requiresSerialTracking,receipt!inner(id,postingDate,status),item!inner(revision,mpn)"
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
  const ledgerResult = await client
    .from("itemLedger")
    .select("documentLineId,quantity,trackedEntityId")
    .eq("companyId", companyId)
    .eq("documentType", "Purchase Receipt")
    .in("documentLineId", lineIds)
    .limit(101);
  if (ledgerResult.error) return { data: null, error: ledgerResult.error };
  const truncatedLedger = (ledgerResult.data?.length ?? 0) > 100;
  const ledgers = (ledgerResult.data ?? []).slice(0, 100) as LedgerRead[];
  const trackedIds = [
    ...new Set(
      ledgers
        .map((entry) => entry.trackedEntityId)
        .filter((id): id is string => Boolean(id))
    )
  ];
  const trackedResult = trackedIds.length
    ? await client
        .from("trackedEntity")
        .select("id,readableId,attributes")
        .eq("companyId", companyId)
        .in("id", trackedIds)
        .limit(100)
    : { data: [], error: null };
  if (trackedResult.error) return { data: null, error: trackedResult.error };
  const summary = summarizeReceiptIdentities(
    lines,
    ledgers,
    (trackedResult.data ?? []) as TrackedEntityRead[]
  );
  const partial =
    truncatedLines ||
    truncatedLedger ||
    summary.items.length > 100 ||
    summary.incompleteReasons.length > 0;
  return {
    data: {
      items: summary.items.slice(0, 100),
      status: partial ? ("partial" as const) : ("complete" as const),
      ...(partial
        ? {
            incompleteReason: [
              ...(truncatedLines ||
              truncatedLedger ||
              summary.items.length > 100
                ? ["bounded-result-truncated"]
                : []),
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
