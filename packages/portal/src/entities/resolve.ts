import {
  type CalendarDate,
  parseAbsolute,
  parseDate,
  toCalendarDate,
  today
} from "@internationalized/date";
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
export type ResolveOptions = {
  /**
   * "Recently received" is a business-calendar question: a receipt is dated
   * by its posting date in the company's timezone, and the window is counted
   * in that calendar, never in UTC instants.
   */
  businessTimezone?: string;
  /** Only receipts posted within this many days (inclusive of today) count. */
  recentDays?: number;
  /** The business "today"; defaults to now in the business timezone. */
  asOf?: CalendarDate;
};
export type ResolvedManual =
  | {
      status: "resolved";
      itemId: string;
      documentVersionId: string;
      receiptId: string;
      /** The posting date of the receipt the answer is grounded on. */
      receivedOn: string;
    }
  | { status: "not-found" }
  | { status: "ambiguous"; choices: string[] };
function units(value: string): bigint {
  if (!/^\d{1,30}(?:\.\d{1,12})?$/.test(value))
    throw new Error("Invalid receipt quantity");
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"));
}
/** The posting date as a business calendar day. A bare date is taken as-is. */
export function receiptCalendarDate(
  receivedAt: string,
  businessTimezone = "UTC"
): CalendarDate {
  const bare = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?Z)?$/.exec(receivedAt);
  if (bare?.[1]) return parseDate(bare[1]);
  return toCalendarDate(parseAbsolute(receivedAt, businessTimezone));
}
export function resolveReceivedManual(
  receipts: ReceiptIdentity[],
  links: ManualLink[],
  options: ResolveOptions = {}
): ResolvedManual {
  if (receipts.length > 100 || links.length > 100)
    throw new Error("Resolver requires bounded authorized input");
  const timezone = options.businessTimezone ?? "UTC";
  const asOf = options.asOf ?? today(timezone);
  const earliest =
    options.recentDays === undefined
      ? undefined
      : asOf.subtract({
          days: Math.max(0, Math.trunc(options.recentDays) - 1)
        });
  const positive = receipts.filter((row) => {
    if (!row.posted || row.voided) return false;
    if (units(row.quantity) <= units(row.reversedQuantity)) return false;
    const day = receiptCalendarDate(row.receivedAt, timezone);
    // A posting date after the business today is not evidence of receipt.
    if (day.compare(asOf) > 0) return false;
    return !earliest || day.compare(earliest) >= 0;
  });
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
    receiptCalendarDate(b.receivedAt, timezone).compare(
      receiptCalendarDate(a.receivedAt, timezone)
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
    documentVersionId: versions[0],
    receivedOn: receiptCalendarDate(receipt.receivedAt, timezone).toString()
  };
}
