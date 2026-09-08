import type { QueryRequest } from "../contracts";
export type QueryRoute = {
  kind: "locate" | "read" | "command";
  searchText: string;
};
/** Source content never participates in routing or changes this fixed capability set. */
export function routeQuery(request: QueryRequest): QueryRoute {
  const text = request.text.normalize("NFC").trim();
  if (
    /\b(?:create|add|move|update|delete)\s+(?:(?:a|the|this)\s+)?(?:ticket|task|card)\b|\bschedule\s+(?:a\s+)?purchase\b/i.test(
      text
    )
  )
    return { kind: "command", searchText: text };
  const locate =
    request.mode === "locate" ||
    (request.mode === "auto" &&
      /^(?:pull up|find|show|open|locate|where is|where's)\b/i.test(text));
  // Remove conversational lead-ins without changing identifier punctuation or case.
  const searchText = text
    .replace(
      /^(?:please\s+)?(?:pull up|find|show(?: me)?|open|locate|where is|where's)\s+/i,
      ""
    )
    .replace(/\b(?:the|for|we|recently|got|a|an)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { kind: locate ? "locate" : "read", searchText: searchText || text };
}
