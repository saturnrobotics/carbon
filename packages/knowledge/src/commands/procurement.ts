import { createHash } from "node:crypto";
import {
  type CalendarDate,
  endOfMonth,
  endOfWeek,
  getDayOfWeek,
  now,
  parseAbsolute,
  parseDate,
  toCalendarDate,
  toCalendarDateTime,
  today,
  toZoned
} from "@internationalized/date";
import { z } from "zod";
import {
  calendarDateSchema,
  nonNegativeDecimalSchema,
  positiveDecimalSchema,
  timestampSchema,
  timezoneSchema
} from "../contracts";

const opaqueId = z.string().min(1).max(256);

/** The current instant as a UTC timestamp — the one "now" these commands use;
 * never JavaScript `Date` arithmetic. */
export function currentInstant(): string {
  return now("UTC").toAbsoluteString();
}

const procurementLineSchema = z
  .object({
    itemId: opaqueId,
    itemRevisionId: opaqueId,
    quantity: positiveDecimalSchema,
    purchaseUnitOfMeasureCode: z.string().min(1).max(32),
    inventoryUnitOfMeasureCode: z.string().min(1).max(32),
    conversionFactor: positiveDecimalSchema,
    supplierUnitPrice: nonNegativeDecimalSchema.optional()
  })
  .strict();

/**
 * The executable wire shape `knowledge-actions` forwards to Carbon. Everything
 * the ERP needs to create a Draft purchase order is present and bounded; the
 * three dates keep their distinct meanings (`requestedArrivalDate` is when the
 * goods should be here, `proposedOrderByDate` is the order date the draft will
 * carry, `executeAt` is when draft creation itself should run).
 */
export const procurementDraftProposalSchema = z
  .object({
    id: opaqueId,
    version: z.number().int().positive(),
    action: z.literal("carbon.procurement.draft"),
    idempotencyKey: opaqueId,
    supplierId: opaqueId,
    receivingLocationId: opaqueId,
    requestedArrivalDate: calendarDateSchema.optional(),
    proposedOrderByDate: calendarDateSchema.optional(),
    executeAt: timestampSchema.optional(),
    businessTimezone: timezoneSchema,
    lines: z.array(procurementLineSchema).min(1).max(100)
  })
  .strict()
  .refine(
    (proposal) =>
      !proposal.requestedArrivalDate ||
      !proposal.proposedOrderByDate ||
      proposal.requestedArrivalDate >= proposal.proposedOrderByDate,
    {
      path: ["requestedArrivalDate"],
      message: "Requested arrival cannot precede the proposed order date"
    }
  );
export type ProcurementDraftProposal = z.infer<
  typeof procurementDraftProposalSchema
>;

// ─── Canonical payload hash ──────────────────────────────────────────────────

/** The business content of a procurement command: what the idempotency key is
 * bound to. Scheduling metadata (`executeAt`) and the key itself are excluded so
 * that a scheduled command and its later execution hash identically. */
export type ProcurementCommandPayload = {
  supplierId: string;
  receivingLocationId: string;
  requestedArrivalDate?: string;
  proposedOrderByDate?: string;
  lines: ReadonlyArray<Record<string, unknown>>;
};

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Deterministic over key order and absent-vs-undefined optional fields, so the
 * knowledge service, the ERP receiver and a scheduled replay agree byte for byte. */
export function procurementCommandPayloadHash(
  payload: ProcurementCommandPayload
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        supplierId: payload.supplierId,
        receivingLocationId: payload.receivingLocationId,
        requestedArrivalDate: payload.requestedArrivalDate,
        proposedOrderByDate: payload.proposedOrderByDate,
        lines: payload.lines
      })
    )
    .digest("hex");
}

// ─── Interpretation of a typed or transcribed request ────────────────────────

export type ProcurementClarificationField =
  | "itemId"
  | "quantity"
  | "supplierId"
  | "receivingLocationId"
  | "purchaseUnitOfMeasureCode"
  | "dateIntent"
  | "requestedArrivalDate"
  | "proposedOrderByDate";

export type ProcurementClarification = {
  field: ProcurementClarificationField;
  question: string;
  choices?: string[];
};

export type ProcurementItemDescriptor = {
  /** The free text that names the part, with dimensions and counts removed. */
  text: string;
  /** Size tokens such as `60x20` or `M6x20` — identity, never a quantity. */
  dimensions: string[];
};

export type ProcurementInterpretation = {
  itemDescriptor?: ProcurementItemDescriptor;
  quantity?: string;
  /** The unit word the person used (`pcs`, `boxes`); mapped to a Carbon code later. */
  purchaseUnitHint?: string;
  requestedArrivalDate?: string;
  proposedOrderByDate?: string;
  /** A date the request named without saying which of the two it means. */
  ambiguousDate?: string;
  clarifications: ProcurementClarification[];
};

const DIMENSION_PATTERN =
  /\b(?:M\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)+|\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)+\s*(?:mm|cm|m|in|inch|")?)\b/gi;
const UNIT_WORDS =
  /^(pcs?|pieces?|units?|ea|each|boxes?|reels?|bags?|kits?|rolls?|sets?|packs?|cases?)$/i;
const QUANTITY_PATTERN =
  /(?<![\w.])(\d+(?:\.\d{1,5})?)(?:\s*(pcs?|pieces?|units?|ea|each|boxes?|reels?|bags?|kits?|rolls?|sets?|packs?|cases?))?(?:\s+of)?\b/gi;
const ARRIVAL_CUE =
  /\b(?:arriv\w*|deliver\w*|need(?:ed)?|here|receiv\w*|in\s+stock|in\s+hand|on\s+hand)\b/gi;
const ORDER_CUE = /\b(?:order\w*|place\w*|purchas\w*|buy|submit\w*)\b/gi;
/** A date introduced this way is a deadline; "for"/"at" say nothing about which. */
const DEADLINE_PREPOSITION = /\b(?:by|on|before)\s*$/i;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];
const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
];

function businessToday(businessTimezone: string, now?: string): CalendarDate {
  return now
    ? toCalendarDate(parseAbsolute(now, businessTimezone))
    : today(businessTimezone);
}

/**
 * Resolve one relative or absolute date phrase on the business calendar. The
 * anchor is "today" in the business timezone, never the process clock, so a
 * request typed late in the evening still means the caller's tomorrow.
 */
export function resolveProcurementDate(
  phrase: string,
  anchor: CalendarDate
): string | undefined {
  const text = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    try {
      return parseDate(text).toString();
    } catch {
      return undefined;
    }
  }
  if (text === "today") return anchor.toString();
  if (text === "tomorrow") return anchor.add({ days: 1 }).toString();
  if (/^(?:the )?(?:end of (?:the |this )?month|month[- ]?end)$/.test(text)) {
    return endOfMonth(anchor).toString();
  }
  if (/^(?:the )?end of next month$/.test(text)) {
    return endOfMonth(anchor.add({ months: 1 })).toString();
  }
  if (/^(?:the )?(?:end of (?:the |this )?week|week[- ]?end)$/.test(text)) {
    return endOfWeek(anchor, "en-GB").toString();
  }
  if (/^(?:the )?end of next week$/.test(text)) {
    return endOfWeek(anchor.add({ weeks: 1 }), "en-GB").toString();
  }
  const relative = /^in (\d{1,3}) (day|week|month)s?$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] as "day" | "week" | "month";
    return anchor.add({ [`${unit}s`]: amount }).toString();
  }
  const weekday = /^(?:next |this )?(\w+day)$/.exec(text);
  if (weekday) {
    const index = WEEKDAYS.indexOf(weekday[1]!);
    if (index >= 0) {
      // "friday" / "this friday" is the next occurrence, never today; "next
      // friday" is that weekday in the following week.
      const base = text.startsWith("next ") ? anchor.add({ weeks: 1 }) : anchor;
      const distance = (index - getDayOfWeek(base, "en-GB") + 7) % 7;
      const offset = text.startsWith("next ") ? distance : distance || 7;
      return base.add({ days: offset }).toString();
    }
  }
  const named =
    /^(?:(\d{1,2})(?:st|nd|rd|th)? (\w+)|(\w+) (\d{1,2})(?:st|nd|rd|th)?)(?:,? (\d{4}))?$/.exec(
      text
    );
  if (named) {
    const monthName = (named[2] ?? named[3])!;
    const day = Number(named[1] ?? named[4]);
    const monthIndex = MONTHS.findIndex(
      (month) => month === monthName || month.slice(0, 3) === monthName
    );
    if (monthIndex >= 0 && day >= 1 && day <= 31) {
      const year = named[5] ? Number(named[5]) : anchor.year;
      try {
        let date = parseDate(
          `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
        );
        if (!named[5] && date.compare(anchor) < 0) {
          date = date.add({ years: 1 });
        }
        return date.toString();
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const DATE_PHRASE =
  /\b((?:the )?(?:end of (?:the |this |next )?(?:month|week)|month[- ]?end|week[- ]?end|today|tomorrow|in \d{1,3} (?:day|week|month)s?|(?:next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:,? \d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?))\b/gi;

type DateMention = {
  phrase: string;
  index: number;
  intent: "arrival" | "order" | "ambiguous";
};

function lastMatchIndex(pattern: RegExp, text: string): number {
  let last = -1;
  for (const match of text.matchAll(pattern)) last = match.index ?? last;
  return last;
}

/** Which of the two meanings a date carries is decided by the nearest verb
 * before it: an arrival verb makes it an arrival date; an ordering verb only
 * does so when the date is introduced as a deadline ("order … by"). "for month
 * end" after "purchase" says nothing about which, and stays ambiguous. */
function classifyDateMentions(text: string): DateMention[] {
  const mentions: DateMention[] = [];
  for (const match of text.matchAll(DATE_PHRASE)) {
    const index = match.index ?? 0;
    const preceding = text.slice(Math.max(0, index - 60), index);
    const arrival = lastMatchIndex(ARRIVAL_CUE, preceding);
    const order = lastMatchIndex(ORDER_CUE, preceding);
    const intent: DateMention["intent"] =
      arrival >= 0 && arrival > order
        ? "arrival"
        : order >= 0 && DEADLINE_PREPOSITION.test(preceding)
          ? "order"
          : "ambiguous";
    mentions.push({ phrase: match[1]!, index, intent });
  }
  return mentions;
}

/**
 * Deterministic interpretation of a typed or transcribed procurement request.
 * Nothing is invented: a request that names no quantity, or a date without
 * saying whether it is an arrival or an order date, yields a clarification
 * rather than a guess. Dimensions (`60x20`) are part of the item's identity and
 * are never read as a count.
 */
export function interpretProcurementRequest(
  text: string,
  options: { businessTimezone: string; now?: string }
): ProcurementInterpretation {
  const businessTimezone = timezoneSchema.parse(options.businessTimezone);
  const anchor = businessToday(businessTimezone, options.now);
  const clarifications: ProcurementClarification[] = [];
  let remainder = text.replace(/\s+/g, " ").trim();

  const dimensions = [...remainder.matchAll(DIMENSION_PATTERN)].map((match) =>
    match[0].replace(/\s+/g, "").replace(/×/g, "x")
  );
  remainder = remainder.replace(DIMENSION_PATTERN, " ");

  const mentions = classifyDateMentions(remainder);
  let requestedArrivalDate: string | undefined;
  let proposedOrderByDate: string | undefined;
  let ambiguousDate: string | undefined;
  for (const mention of mentions) {
    const resolved = resolveProcurementDate(mention.phrase, anchor);
    const field =
      mention.intent === "arrival"
        ? "requestedArrivalDate"
        : mention.intent === "order"
          ? "proposedOrderByDate"
          : "dateIntent";
    if (!resolved) {
      clarifications.push({
        field,
        question: `Which calendar date does "${mention.phrase}" mean?`
      });
    } else if (mention.intent === "arrival") {
      requestedArrivalDate = resolved;
    } else if (mention.intent === "order") {
      proposedOrderByDate = resolved;
    } else {
      ambiguousDate = resolved;
    }
  }
  if (ambiguousDate && !clarifications.some((c) => c.field === "dateIntent")) {
    clarifications.push({
      field: "dateIntent",
      question: `Is ${ambiguousDate} when the parts must arrive, or when the order should be placed?`,
      choices: ["requestedArrivalDate", "proposedOrderByDate"]
    });
  }
  remainder = remainder.replace(DATE_PHRASE, " ");
  remainder = remainder.replace(
    /\b(?:to\s+)?(?:arriv\w*|deliver\w*|need(?:ed)?|here|receiv\w*|in\s+stock|in\s+hand|on\s+hand)\b/gi,
    " "
  );
  remainder = remainder.replace(/\b(?:for|at|by|on|before)\b/gi, " ");

  const quantities = [...remainder.matchAll(QUANTITY_PATTERN)];
  let quantity: string | undefined;
  let purchaseUnitHint: string | undefined;
  if (quantities.length === 1) {
    const candidate = quantities[0]![1]!;
    if (positiveDecimalSchema.safeParse(candidate).success) {
      quantity = candidate;
      purchaseUnitHint = quantities[0]![2]?.toLowerCase();
    }
  } else if (quantities.length > 1) {
    clarifications.push({
      field: "quantity",
      question: "Which quantity should be ordered?",
      choices: quantities.map((match) => match[1]!)
    });
  }
  if (!quantity && !clarifications.some((c) => c.field === "quantity")) {
    clarifications.push({
      field: "quantity",
      question: "How many should be ordered, and in which purchase unit?"
    });
  }
  remainder = remainder.replace(QUANTITY_PATTERN, " ");

  const descriptorText = remainder
    .replace(
      /\b(schedule|please|order|purchase|place|submit|buy|procure|get|of|the|a|an|some|to|units?|pcs?|pieces?)\b/gi,
      " "
    )
    .replace(/[,.;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const itemDescriptor =
    descriptorText || dimensions.length
      ? { text: descriptorText, dimensions }
      : undefined;
  if (!itemDescriptor) {
    clarifications.push({
      field: "itemId",
      question: "Which item should be purchased?"
    });
  }

  return {
    ...(itemDescriptor ? { itemDescriptor } : {}),
    ...(quantity ? { quantity } : {}),
    ...(purchaseUnitHint && UNIT_WORDS.test(purchaseUnitHint)
      ? { purchaseUnitHint }
      : {}),
    ...(requestedArrivalDate ? { requestedArrivalDate } : {}),
    ...(proposedOrderByDate ? { proposedOrderByDate } : {}),
    ...(ambiguousDate ? { ambiguousDate } : {}),
    clarifications
  };
}

// ─── Versioned proposal ──────────────────────────────────────────────────────

/** The fields a proposal accumulates across clarification rounds. Every one is
 * optional here; `buildProcurementProposal` decides what is still missing. */
export const procurementProposalFieldsSchema = z
  .object({
    itemId: opaqueId.optional(),
    itemRevisionId: opaqueId.optional(),
    itemDescriptor: z
      .object({
        text: z.string().max(500),
        dimensions: z.array(z.string().min(1).max(64)).max(10)
      })
      .strict()
      .optional(),
    quantity: positiveDecimalSchema.optional(),
    purchaseUnitOfMeasureCode: z.string().min(1).max(32).optional(),
    inventoryUnitOfMeasureCode: z.string().min(1).max(32).optional(),
    conversionFactor: positiveDecimalSchema.optional(),
    supplierUnitPrice: nonNegativeDecimalSchema.optional(),
    supplierId: opaqueId.optional(),
    receivingLocationId: opaqueId.optional(),
    requestedArrivalDate: calendarDateSchema.optional(),
    proposedOrderByDate: calendarDateSchema.optional(),
    executeAt: timestampSchema.optional()
  })
  .strict();
export type ProcurementProposalFields = z.infer<
  typeof procurementProposalFieldsSchema
>;

export const procurementProposalSchema = z
  .object({
    id: opaqueId,
    version: z.number().int().positive(),
    action: z.literal("carbon.procurement.draft"),
    idempotencyKey: opaqueId,
    businessTimezone: timezoneSchema,
    fields: procurementProposalFieldsSchema,
    clarifications: z
      .array(
        z
          .object({
            field: z.enum([
              "itemId",
              "quantity",
              "supplierId",
              "receivingLocationId",
              "purchaseUnitOfMeasureCode",
              "dateIntent",
              "requestedArrivalDate",
              "proposedOrderByDate"
            ]),
            question: z.string().min(1).max(500),
            choices: z
              .array(z.string().min(1).max(500))
              .min(1)
              .max(20)
              .optional()
          })
          .strict()
      )
      .max(20),
    /** A date the request named without saying which of the two it means;
     * kept until a `dateIntent` answer assigns it. */
    ambiguousDate: calendarDateSchema.optional(),
    status: z.enum(["needs-clarification", "ready"])
  })
  .strict();
export type ProcurementProposal = z.infer<typeof procurementProposalSchema>;

const REQUIRED_FIELDS: ReadonlyArray<{
  field: keyof ProcurementProposalFields;
  clarification: ProcurementClarificationField;
  question: string;
}> = [
  {
    field: "itemId",
    clarification: "itemId",
    question: "Which item should be purchased?"
  },
  {
    field: "quantity",
    clarification: "quantity",
    question: "How many should be ordered?"
  },
  {
    field: "purchaseUnitOfMeasureCode",
    clarification: "purchaseUnitOfMeasureCode",
    question: "Which purchase unit of measure applies?"
  },
  // The inventory unit and conversion factor are read from Carbon, not asked of
  // the person; until the resolver has confirmed them the proposal is not
  // executable, because the ERP compares them against its own supplier settings.
  {
    field: "inventoryUnitOfMeasureCode",
    clarification: "purchaseUnitOfMeasureCode",
    question:
      "Confirm the purchase unit, inventory unit and conversion factor for this item and supplier"
  },
  {
    field: "conversionFactor",
    clarification: "purchaseUnitOfMeasureCode",
    question:
      "Confirm the purchase unit, inventory unit and conversion factor for this item and supplier"
  },
  {
    field: "supplierId",
    clarification: "supplierId",
    question: "Which supplier should receive the order?"
  },
  {
    field: "receivingLocationId",
    clarification: "receivingLocationId",
    question: "Which location should receive the goods?"
  }
];

/**
 * Compute a proposal's outstanding clarifications from its fields. Executable
 * only when every required field is present and the dates are consistent; an
 * incomplete request stays a proposal and never becomes a Carbon record.
 */
export function buildProcurementProposal(input: {
  id: string;
  idempotencyKey: string;
  version?: number;
  businessTimezone: string;
  fields: ProcurementProposalFields;
  /** Carried from an interpretation whose date needs its meaning confirmed. */
  ambiguousDate?: string;
}): ProcurementProposal {
  const fields = procurementProposalFieldsSchema.parse(input.fields);
  const clarifications: ProcurementClarification[] = [];
  for (const required of REQUIRED_FIELDS) {
    if (
      fields[required.field] === undefined &&
      !clarifications.some((c) => c.field === required.clarification)
    ) {
      clarifications.push({
        field: required.clarification,
        question: required.question
      });
    }
  }
  if (fields.itemId && !fields.itemRevisionId) {
    clarifications.push({
      field: "itemId",
      question: "Which released revision of the item should be ordered?"
    });
  }
  if (
    input.ambiguousDate &&
    !fields.requestedArrivalDate &&
    !fields.proposedOrderByDate
  ) {
    clarifications.push({
      field: "dateIntent",
      question: `Is ${input.ambiguousDate} when the parts must arrive, or when the order should be placed?`,
      choices: ["requestedArrivalDate", "proposedOrderByDate"]
    });
  }
  if (
    fields.requestedArrivalDate &&
    fields.proposedOrderByDate &&
    fields.requestedArrivalDate < fields.proposedOrderByDate
  ) {
    clarifications.push({
      field: "requestedArrivalDate",
      question: `Arrival on ${fields.requestedArrivalDate} precedes ordering on ${fields.proposedOrderByDate}; which date is wrong?`,
      choices: [fields.requestedArrivalDate, fields.proposedOrderByDate]
    });
  }
  return procurementProposalSchema.parse({
    id: input.id,
    version: input.version ?? 1,
    action: "carbon.procurement.draft",
    idempotencyKey: input.idempotencyKey,
    businessTimezone: input.businessTimezone,
    fields,
    clarifications,
    ...(input.ambiguousDate &&
    !fields.requestedArrivalDate &&
    !fields.proposedOrderByDate
      ? { ambiguousDate: input.ambiguousDate }
      : {}),
    status: clarifications.length === 0 ? "ready" : "needs-clarification"
  });
}

/** Apply clarification answers as a new proposal version; the id and the
 * idempotency key never change, so a revised proposal still converges on one
 * purchase order once it executes. */
export function reviseProcurementProposal(
  previous: ProcurementProposal,
  answers: Partial<ProcurementProposalFields> & {
    dateIntent?: "requestedArrivalDate" | "proposedOrderByDate";
    ambiguousDate?: string;
  }
): ProcurementProposal {
  const { dateIntent, ...fieldAnswers } = answers;
  const ambiguousDate = answers.ambiguousDate ?? previous.ambiguousDate;
  const fields: ProcurementProposalFields = { ...previous.fields };
  for (const [key, value] of Object.entries(fieldAnswers)) {
    if (key !== "ambiguousDate" && value !== undefined) {
      (fields as Record<string, unknown>)[key] = value;
    }
  }
  if (dateIntent && ambiguousDate) fields[dateIntent] = ambiguousDate;
  return buildProcurementProposal({
    id: previous.id,
    idempotencyKey: previous.idempotencyKey,
    version: previous.version + 1,
    businessTimezone: previous.businessTimezone,
    fields,
    ...(dateIntent ? {} : { ambiguousDate })
  });
}

/** The executable command for a ready proposal; throws while anything is open. */
export function toExecutableProcurementProposal(
  proposal: ProcurementProposal
): ProcurementDraftProposal {
  const parsed = procurementProposalSchema.parse(proposal);
  if (parsed.status !== "ready" || parsed.clarifications.length > 0) {
    throw new Error("Procurement proposal has unresolved clarification");
  }
  const { fields } = parsed;
  return procurementDraftProposalSchema.parse({
    id: parsed.id,
    version: parsed.version,
    action: "carbon.procurement.draft",
    idempotencyKey: parsed.idempotencyKey,
    supplierId: fields.supplierId,
    receivingLocationId: fields.receivingLocationId,
    requestedArrivalDate: fields.requestedArrivalDate,
    proposedOrderByDate: fields.proposedOrderByDate,
    executeAt: fields.executeAt,
    businessTimezone: parsed.businessTimezone,
    lines: [
      {
        itemId: fields.itemId,
        itemRevisionId: fields.itemRevisionId,
        quantity: fields.quantity,
        purchaseUnitOfMeasureCode: fields.purchaseUnitOfMeasureCode,
        inventoryUnitOfMeasureCode: fields.inventoryUnitOfMeasureCode,
        conversionFactor: fields.conversionFactor,
        supplierUnitPrice: fields.supplierUnitPrice
      }
    ]
  });
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

export type ScheduledExecution =
  | { mode: "immediate" }
  | { mode: "scheduled"; executeAt: string };

/**
 * When should Carbon create the draft? An explicit future `executeAt` wins; a
 * `proposedOrderByDate` alone means the start of that business day in the
 * business timezone. Anything already due runs immediately — a deferred command
 * whose moment has passed is not silently dropped.
 */
export function resolveScheduledExecution(input: {
  proposedOrderByDate?: string;
  executeAt?: string;
  businessTimezone: string;
  now: string;
}): ScheduledExecution {
  const businessTimezone = timezoneSchema.parse(input.businessTimezone);
  const now = parseAbsolute(timestampSchema.parse(input.now), businessTimezone);
  if (input.executeAt) {
    const explicit = parseAbsolute(
      timestampSchema.parse(input.executeAt),
      businessTimezone
    );
    return explicit.compare(now) > 0
      ? { mode: "scheduled", executeAt: explicit.toAbsoluteString() }
      : { mode: "immediate" };
  }
  if (input.proposedOrderByDate) {
    const orderDay = parseDate(
      calendarDateSchema.parse(input.proposedOrderByDate)
    );
    if (orderDay.compare(toCalendarDate(now)) > 0) {
      return {
        mode: "scheduled",
        executeAt: toZoned(
          toCalendarDateTime(orderDay),
          businessTimezone
        ).toAbsoluteString()
      };
    }
  }
  return { mode: "immediate" };
}
