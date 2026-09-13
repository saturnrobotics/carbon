import { round } from "@carbon/utils";
import { parseDate } from "@internationalized/date";

export type ReceiptLineRead = {
  id: string;
  itemId: string;
  receivedQuantity: number;
  requiresBatchTracking: boolean;
  requiresSerialTracking: boolean;
  receipt: {
    id: string;
    postingDate: string | null;
    status: string;
  };
  item: { revision: string | null; mpn: string | null };
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
  | "ambiguous-lot";

/**
 * The attribute a receipt writes onto every lot and serial it creates. It is
 * the canonical link from a tracked entity back to the line that received it —
 * `update_receipt_line_batch_tracking` writes it, `post-receipt` reads it to
 * stamp `itemLedger.trackedEntityId`, and the ERP's own receipt, quality and
 * RMA reads join on it.
 */
const RECEIPT_LINE = "Receipt Line";
/** Which unit of a serial-tracked line an entity is, zero-based. */
const RECEIPT_LINE_INDEX = "Receipt Line Index";
/**
 * A batch split CLONES the parent's attributes onto the child, so a split
 * descendant names the same receipt line as the lot the receipt created. Only
 * the entity the receipt itself created is receipt provenance; its descendants
 * are later movements of that lot.
 */
const SPLIT_PARENT = "Split From Entity ID";

function attributesOf(entity: TrackedEntityRead): Record<string, unknown> {
  return entity.attributes && typeof entity.attributes === "object"
    ? (entity.attributes as Record<string, unknown>)
    : {};
}

function text(
  attributes: Record<string, unknown>,
  name: string
): string | undefined {
  const value = attributes[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatQuantity(value: number): string {
  return String(round(value));
}

/** Entities a receipt created, keyed by line, in a stable order. */
function receiptEntitiesByLine(
  trackedEntities: TrackedEntityRead[]
): Map<string, TrackedEntityRead[]> {
  const byLine = new Map<string, TrackedEntityRead[]>();
  const indexOf = new Map<string, number>();
  for (const entity of trackedEntities) {
    const attributes = attributesOf(entity);
    if (attributes[SPLIT_PARENT] !== undefined) continue;
    const lineId = text(attributes, RECEIPT_LINE);
    if (!lineId) continue;
    const index = attributes[RECEIPT_LINE_INDEX];
    if (typeof index === "number" && Number.isFinite(index))
      indexOf.set(entity.id, index);
    byLine.set(lineId, [...(byLine.get(lineId) ?? []), entity]);
  }
  // A serial line's units are the entity order the receipt screen assigned;
  // an unindexed entity sorts last so the indexed ones keep their positions.
  for (const entities of byLine.values())
    entities.sort(
      (left, right) =>
        (indexOf.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (indexOf.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
    );
  return byLine;
}

/**
 * Pure projection used by the bounded reader and its regression tests.
 *
 * The receipt LINE is the record of what was received: `receivedQuantity` is
 * the number `post-receipt` books, and the tracked entities carry the lot and
 * serial identities. Neither answer needs the inventory ledger, which is
 * derived from both and, for a purchase receipt, is not keyed on the line at
 * all.
 *
 * `reversedQuantity` is therefore always zero here: the only writer of a
 * reversing `Purchase Receipt` ledger row is the void path, and it flips the
 * receipt to `Voided` in the same transaction — so a reversed receipt is one
 * the caller's `Posted` filter has already excluded, not a row with a
 * reversal on it. The field stays in the projection because the resolver
 * compares the pair.
 */
export function summarizeReceiptIdentities(
  lines: ReceiptLineRead[],
  trackedEntities: TrackedEntityRead[]
): {
  items: ReceiptIdentityProjection[];
  incompleteReasons: ReceiptIdentityIncompleteReason[];
} {
  const incompleteReasons = new Set<ReceiptIdentityIncompleteReason>();
  const entitiesByLine = receiptEntitiesByLine(trackedEntities);

  const items = lines.flatMap((line): ReceiptIdentityProjection[] => {
    // A posted line that received nothing is a complete answer of zero, not a
    // gap in what can be read — it is simply not evidence that anything landed.
    if (!Number.isFinite(line.receivedQuantity) || line.receivedQuantity <= 0)
      return [];

    let receivedAt: string;
    try {
      if (!line.receipt.postingDate) throw new Error("Missing posting date");
      receivedAt = `${parseDate(line.receipt.postingDate).toString()}T00:00:00Z`;
    } catch {
      incompleteReasons.add("invalid-posting-date");
      return [];
    }

    const project = (
      quantity: number,
      entity?: TrackedEntityRead
    ): ReceiptIdentityProjection => {
      const attributes = entity ? attributesOf(entity) : {};
      const serial = line.requiresSerialTracking
        ? (text(attributes, "Serial") ?? entity?.readableId ?? undefined)
        : undefined;
      const lot = line.requiresBatchTracking
        ? (text(attributes, "Lot") ?? entity?.readableId ?? undefined)
        : undefined;
      const variant = text(attributes, "Variant");
      const missingIdentityFields: MissingReceiptIdentityField[] = [
        "manufacturer",
        ...(!line.item.mpn ? (["mpn"] as const) : []),
        ...(line.requiresSerialTracking && !serial
          ? (["serial"] as const)
          : []),
        ...(line.requiresBatchTracking && !lot ? (["lot"] as const) : [])
      ];
      if (missingIdentityFields.length > 0)
        incompleteReasons.add("missing-identity");
      return {
        id: line.receipt.id,
        itemId: line.itemId,
        revision: line.item.revision ?? "",
        manufacturer: "",
        mpn: line.item.mpn ?? "",
        receivedAt,
        quantity: formatQuantity(quantity),
        reversedQuantity: "0",
        posted: true,
        voided: false,
        ...(serial ? { serial } : {}),
        ...(lot ? { lot } : {}),
        ...(variant ? { variant } : {}),
        ...(missingIdentityFields.length > 0 ? { missingIdentityFields } : {})
      };
    };

    const entities = entitiesByLine.get(line.id) ?? [];

    if (line.requiresSerialTracking) {
      // One unit per serial, the way the receipt books them. Units the receipt
      // never got a serial for stay one row without one, so a partly
      // serialised line cannot resolve as if every unit were identified.
      const unidentified = round(line.receivedQuantity - entities.length);
      return [
        ...entities.map((entity) => project(1, entity)),
        ...(unidentified > 0 ? [project(unidentified)] : [])
      ];
    }

    if (line.requiresBatchTracking) {
      // A batch line carries exactly one lot: the tracking function upserts a
      // single entity per line under an advisory lock. More than one lot means
      // the received quantity cannot be attributed, so say so rather than
      // guessing which lot it landed in.
      const lots = new Map(
        entities.map((entity) => [entity.readableId ?? entity.id, entity])
      );
      if (lots.size > 1) {
        incompleteReasons.add("ambiguous-lot");
        return [];
      }
      return [project(line.receivedQuantity, [...lots.values()][0])];
    }

    return [project(line.receivedQuantity)];
  });

  return { items, incompleteReasons: [...incompleteReasons] };
}
