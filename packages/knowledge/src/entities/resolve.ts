import { parseAbsolute } from "@internationalized/date";
export type ReceiptIdentity = {
  id: string;
  itemId: string;
  revision: string;
  manufacturer: string;
  mpn: string;
  receivedAt: string;
  quantity: string;
  reversedQuantity: string;
  posted: boolean;
  voided: boolean;
  serial?: string;
  lot?: string;
  variant?: string;
  missingIdentityFields?: Array<"manufacturer" | "mpn" | "serial" | "lot">;
};
export type ManualLink = {
  documentVersionId: string;
  itemId: string;
  revision: string;
  manufacturer: string;
  mpn: string;
  verified: boolean;
  serial?: string;
  lot?: string;
  variant?: string;
};
function units(value: string): bigint {
  if (!/^\d{1,30}(?:\.\d{1,12})?$/.test(value))
    throw new Error("Invalid receipt quantity");
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"));
}
export function resolveReceivedManual(
  receipts: ReceiptIdentity[],
  links: ManualLink[]
):
  | {
      status: "resolved";
      itemId: string;
      documentVersionId: string;
      receiptId: string;
    }
  | { status: "not-found" }
  | { status: "ambiguous"; choices: string[] } {
  if (receipts.length > 100 || links.length > 100)
    throw new Error("Resolver requires bounded authorized input");
  const positive = receipts.filter(
    (row) =>
      row.posted &&
      !row.voided &&
      units(row.quantity) > units(row.reversedQuantity)
  );
  if (
    positive.some(
      (row) =>
        row.missingIdentityFields?.length ||
        !row.manufacturer.trim() ||
        !row.mpn.trim()
    )
  )
    return { status: "not-found" };
  const identities = new Set(
    positive.map((row) =>
      JSON.stringify([
        row.itemId,
        row.revision,
        row.mpn,
        row.manufacturer,
        row.variant,
        row.serial,
        row.lot
      ])
    )
  );
  if (identities.size > 1)
    return {
      status: "ambiguous",
      choices: [
        ...new Set(
          positive.map(
            (row) =>
              `${row.itemId}@${row.revision}${row.serial ? `:${row.serial}` : ""}${row.variant ? `:${row.variant}` : ""}`
          )
        )
      ]
    };
  const receipt = positive.sort((a, b) =>
    parseAbsolute(b.receivedAt, "UTC").compare(
      parseAbsolute(a.receivedAt, "UTC")
    )
  )[0];
  if (!receipt) return { status: "not-found" };
  const matches = links.filter(
    (link) =>
      link.verified &&
      link.itemId === receipt.itemId &&
      link.revision === receipt.revision &&
      link.manufacturer.normalize("NFC") ===
        receipt.manufacturer.normalize("NFC") &&
      link.mpn.normalize("NFC") === receipt.mpn.normalize("NFC") &&
      ["serial", "lot", "variant"].every((field) => {
        const key = field as "serial" | "lot" | "variant";
        return link[key] === undefined || link[key] === receipt[key];
      })
  );
  const versions = [...new Set(matches.map((row) => row.documentVersionId))];
  if (versions.length > 1) return { status: "ambiguous", choices: versions };
  if (!versions[0]) return { status: "not-found" };
  return {
    status: "resolved",
    itemId: receipt.itemId,
    receiptId: receipt.id,
    documentVersionId: versions[0]
  };
}
