import type { QueryRequest } from "../contracts";
import { QUERY_BUDGETS } from "./budgets";

/**
 * The registered capabilities a request can be routed to. This is the whole
 * catalog the router chooses from: a compact description, the typed input
 * each capability takes, its deadline, its projection limits and whether it
 * is allowed one bounded answer inference. It is frozen at module load and
 * built from nothing but this file, so neither a request nor any retrieved
 * source text can add, remove or widen an entry.
 */
export type CapabilityId =
  | "document.locate"
  | "document.answer"
  | "source.entities"
  | "source.received-manual"
  | "command.propose";

export type CapabilityDescriptor = {
  readonly id: CapabilityId;
  readonly description: string;
  /** The only input the capability receives; nothing else from the request. */
  readonly input: "searchText" | "structuredIntent" | "commandText";
  readonly deadlineMs: number;
  readonly projection: {
    readonly candidatesPerSource: number;
    readonly sourcesPerRequest: number;
    readonly evidenceBlocks: number;
  };
  /** `none`: no model call of any kind; `answer`: exactly one bounded call. */
  readonly inference: "none" | "answer";
};

const projection = Object.freeze({
  candidatesPerSource: QUERY_BUDGETS.candidatesPerSource,
  sourcesPerRequest: QUERY_BUDGETS.sourcesPerRequest,
  evidenceBlocks: QUERY_BUDGETS.evidenceBlocks
});
const singleProjection = Object.freeze({
  candidatesPerSource: 1,
  sourcesPerRequest: 1,
  evidenceBlocks: 1
});

function capability(
  descriptor: CapabilityDescriptor
): Readonly<CapabilityDescriptor> {
  return Object.freeze(descriptor);
}

export const QUERY_CAPABILITIES: Readonly<
  Record<CapabilityId, Readonly<CapabilityDescriptor>>
> = Object.freeze({
  "document.locate": capability({
    id: "document.locate",
    description: "Find authorized documents by identifier or keyword",
    input: "searchText",
    deadlineMs: QUERY_BUDGETS.retrievalDeadlineMs,
    projection,
    inference: "none"
  }),
  "document.answer": capability({
    id: "document.answer",
    description: "Answer from authorized evidence with cited claims",
    input: "searchText",
    deadlineMs: QUERY_BUDGETS.requestDeadlineMs,
    projection,
    inference: "answer"
  }),
  "source.entities": capability({
    id: "source.entities",
    description: "Look up records in a registered live source",
    input: "structuredIntent",
    deadlineMs: QUERY_BUDGETS.sourceDeadlineMs,
    projection,
    inference: "none"
  }),
  "source.received-manual": capability({
    id: "source.received-manual",
    description: "Resolve the applicable manual for a recently received item",
    input: "structuredIntent",
    deadlineMs: QUERY_BUDGETS.sourceDeadlineMs,
    projection: singleProjection,
    inference: "none"
  }),
  "command.propose": capability({
    id: "command.propose",
    description: "Propose a permitted typed command for explicit confirmation",
    input: "commandText",
    deadlineMs: QUERY_BUDGETS.requestDeadlineMs,
    projection: singleProjection,
    inference: "none"
  })
});

/** A deterministic structured intent, decided from the request text alone. */
export type StructuredIntent =
  | { readonly kind: "tickets"; readonly searchText: string }
  | { readonly kind: "purchase-order"; readonly purchaseOrderId: string }
  | { readonly kind: "received-manual" }
  | { readonly kind: "parts"; readonly searchText: string }
  | { readonly kind: "entities"; readonly searchText: string };

export type QueryRoute = {
  kind: "locate" | "read" | "command";
  searchText: string;
  capability: CapabilityId;
  /** Present when a registered live source answers before any index. */
  structured?: StructuredIntent;
};

const leadIn =
  /^(?:please\s+)?(?:pull up|find|show(?: me)?|open|locate|where is|where's)\s+/i;

function stripWords(text: string, words: RegExp): string {
  return text.replace(words, " ").replace(/\s+/g, " ").trim();
}

/**
 * Deterministic structured routing: every rule reads the request text and
 * nothing else, runs before any index or model, and names one registered
 * capability. Source text can neither reach these rules nor change them.
 */
export function structuredIntent(text: string): StructuredIntent | undefined {
  const manual =
    /\bmanual\b/i.test(text) &&
    /\b(?:recently|got|received|bought|purchased)\b/i.test(text);
  if (manual) return { kind: "received-manual" };
  if (/\b(?:ticket|tickets|task|tasks)\b/i.test(text))
    return {
      kind: "tickets",
      searchText: stripWords(
        text.replace(leadIn, ""),
        /\b(?:tickets?|tasks?|the|for)\b/gi
      )
    };
  const purchase = /\b(?:purchase order|PO)[\s:#-]*([A-Za-z0-9_./-]+)/i.exec(
    text
  );
  if (purchase?.[1])
    return { kind: "purchase-order", purchaseOrderId: purchase[1] };
  if (
    /^(?:please\s+)?(?:find|show|open|locate)(?:\s+me)?\s+(?:the\s+)?(?:parts?|items?)\b/i.test(
      text
    )
  )
    return {
      kind: "parts",
      searchText: stripWords(
        text.replace(leadIn, ""),
        /\b(?:parts?|items?|the|for)\b/gi
      )
    };
  if (
    /^(?:please\s+)?(?:find|show|open|locate)(?:\s+me)?\s+(?:the\s+)?(?:customers?|contacts?|parts?|assembl(?:y|ies)|pcbs?|machines?)\b/i.test(
      text
    )
  )
    return { kind: "entities", searchText: text };
  return undefined;
}

/** Source content never participates in routing or changes this fixed capability set. */
export function routeQuery(request: QueryRequest): QueryRoute {
  const text = request.text.normalize("NFC").trim();
  if (
    /\b(?:create|add|move|update|delete)\s+(?:(?:a|the|this)\s+)?(?:ticket|task|card)\b|\bschedule\s+(?:a\s+)?purchase\b/i.test(
      text
    )
  )
    return { kind: "command", searchText: text, capability: "command.propose" };
  const locate =
    request.mode === "locate" ||
    (request.mode === "auto" &&
      /^(?:pull up|find|show|open|locate|where is|where's)\b/i.test(text));
  // Remove conversational lead-ins without changing identifier punctuation or case.
  const searchText = stripWords(
    text.replace(leadIn, ""),
    /\b(?:the|for|we|recently|got|a|an)\b/gi
  );
  const structured = structuredIntent(text);
  const route: QueryRoute = {
    kind: locate ? "locate" : "read",
    searchText: searchText || text,
    capability: locate ? "document.locate" : "document.answer"
  };
  if (structured) {
    route.structured = structured;
    route.capability =
      structured.kind === "received-manual"
        ? "source.received-manual"
        : "source.entities";
  }
  return route;
}
