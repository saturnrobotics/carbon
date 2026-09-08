import { round } from "@carbon/utils";
import { parseDate } from "@internationalized/date";

export type ReceiptLineRead = {
  id: string;
  itemId: string;
  requiresBatchTracking: boolean;
  requiresSerialTracking: boolean;
  receipt: {
    id: string;
    postingDate: string | null;
    status: string;
  };
  item: { revision: string | null; mpn: string | null };
};

export type LedgerRead = {
  documentLineId: string | null;
  quantity: number;
  trackedEntityId: string | null;
};

export type TrackedEntityRead = {
  id: string;
  readableId: string | null;
  attributes: unknown;
};

type MissingReceiptIdentityField = "manufacturer" | "mpn" | "serial" | "lot";

export type ReceiptIdentityProjection = {
  id: string;
  itemId: string;
  revision: string;
  manufacturer: string;
  mpn: string;
  receivedAt: string;
  quantity: string;
  reversedQuantity: string;
  posted: true;
  voided: false;
  serial?: string;
  lot?: string;
  variant?: string;
  missingIdentityFields?: MissingReceiptIdentityField[];
};

type ReceiptIdentityIncompleteReason =
  | "invalid-posting-date"
  | "missing-identity"
  | "missing-ledger";

function attribute(
  attributes: unknown,
  name: "Variant" | "Lot" | "Serial"
): string | undefined {
  if (!attributes || typeof attributes !== "object") return undefined;
  const value = (attributes as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function addQuantity(left: number, right: number): number {
  return round(left + right);
}

function formatQuantity(value: number): string {
  return String(round(value));
}

/** Pure projection used by the bounded reader and its ledger regression tests. */
export function summarizeReceiptIdentities(
  lines: ReceiptLineRead[],
  ledgers: LedgerRead[],
  trackedEntities: TrackedEntityRead[]
): {
  items: ReceiptIdentityProjection[];
  incompleteReasons: ReceiptIdentityIncompleteReason[];
} {
  const incompleteReasons = new Set<ReceiptIdentityIncompleteReason>();
  const tracked = new Map(trackedEntities.map((entity) => [entity.id, entity]));
  const ledgersByLine = new Map<string, LedgerRead[]>();
  for (const entry of ledgers) {
    if (!entry.documentLineId) continue;
    const entries = ledgersByLine.get(entry.documentLineId) ?? [];
    entries.push(entry);
    ledgersByLine.set(entry.documentLineId, entries);
  }

  const items = lines.flatMap((line): ReceiptIdentityProjection[] => {
    const entries = ledgersByLine.get(line.id) ?? [];
    if (entries.length === 0 || !entries.some((entry) => entry.quantity > 0)) {
      incompleteReasons.add("missing-ledger");
      return [];
    }

    let receivedAt: string;
    try {
      if (!line.receipt.postingDate) throw new Error("Missing posting date");
      receivedAt = `${parseDate(line.receipt.postingDate).toString()}T00:00:00Z`;
    } catch {
      incompleteReasons.add("invalid-posting-date");
      return [];
    }

    const entriesByTrackedEntity = new Map<string | null, LedgerRead[]>();
    for (const entry of entries) {
      const key = entry.trackedEntityId;
      const group = entriesByTrackedEntity.get(key) ?? [];
      group.push(entry);
      entriesByTrackedEntity.set(key, group);
    }

    return [...entriesByTrackedEntity.entries()].flatMap(
      ([trackedEntityId, entityEntries]): ReceiptIdentityProjection[] => {
        if (!entityEntries.some((entry) => entry.quantity > 0)) return [];
        const quantity = entityEntries
          .filter((entry) => entry.quantity > 0)
          .reduce((sum, entry) => addQuantity(sum, entry.quantity), 0);
        const reversedQuantity = entityEntries
          .filter((entry) => entry.quantity < 0)
          .reduce((sum, entry) => addQuantity(sum, -entry.quantity), 0);
        const entity = trackedEntityId
          ? tracked.get(trackedEntityId)
          : undefined;
        const serial = line.requiresSerialTracking
          ? (attribute(entity?.attributes, "Serial") ??
            entity?.readableId ??
            undefined)
          : undefined;
        const lot = line.requiresBatchTracking
          ? (attribute(entity?.attributes, "Lot") ??
            entity?.readableId ??
            undefined)
          : undefined;
        const missingIdentityFields: MissingReceiptIdentityField[] = [
          "manufacturer",
          ...(!line.item.mpn ? (["mpn"] as const) : []),
          ...(line.requiresSerialTracking && !serial
            ? (["serial"] as const)
            : []),
          ...(line.requiresBatchTracking && !lot ? (["lot"] as const) : [])
        ];
        if (missingIdentityFields.length > 0) {
          incompleteReasons.add("missing-identity");
        }

        return [
          {
            id: line.receipt.id,
            itemId: line.itemId,
            revision: line.item.revision ?? "",
            manufacturer: "",
            mpn: line.item.mpn ?? "",
            receivedAt,
            quantity: formatQuantity(quantity),
            reversedQuantity: formatQuantity(reversedQuantity),
            posted: true,
            voided: false,
            ...(serial ? { serial } : {}),
            ...(lot ? { lot } : {}),
            ...(attribute(entity?.attributes, "Variant")
              ? { variant: attribute(entity?.attributes, "Variant") }
              : {}),
            ...(missingIdentityFields.length > 0
              ? { missingIdentityFields }
              : {})
          }
        ];
      }
    );
  });

  return { items, incompleteReasons: [...incompleteReasons] };
}
