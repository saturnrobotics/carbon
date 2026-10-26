// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

// The operation catalog for the Carbon API v1 surface. Reads the generated MCP
// manifest (tool-metadata.json, gitignored build output of `pnpm generate:mcp`)
// and shapes it for the oRPC router and the MCP/agent bridges — a single source
// of truth for HTTP and MCP.

import type { ManifestEntry } from "@carbon/api";
import { isPortalOperation } from "~/modules/portal/portal.server";
import raw from "../../mcp+/lib/tool-metadata.json";

export const OPERATIONS = (raw as { tools: ManifestEntry[] }).tools;

const companyTables = (raw as { companyTables?: string[] }).companyTables;
// The dispatcher confines every write to the caller's company by this list
// (`scopedToCompany`). An empty one would switch that off without a sound, so
// a manifest generated before the list existed stops the module loading.
if (!Array.isArray(companyTables) || companyTables.length === 0) {
  throw new Error(
    "tool-metadata.json has no companyTables. Regenerate it: pnpm run generate:mcp"
  );
}

/** Every table with a `companyId` column, from the generated database types. */
export const COMPANY_TABLES: ReadonlySet<string> = new Set(companyTables);
/** Every published operation by its name. */
export const operationsByName = new Map<string, ManifestEntry>(
  OPERATIONS.map((op) => [op.name, op])
);

/**
 * Whether an operation may be disclosed by MCP discovery (`search_tools`,
 * `describe_tool`, the well-known manifest, the connect-time instructions) and
 * by the public OpenAPI document. Portal operations are served only to
 * delegated workforce callers — the gate answers NOT_FOUND to everyone else —
 * so listing them where an API key or a connector reads is a promise that
 * cannot be kept. They stay in `OPERATIONS`, and so in the router and the
 * committed manifest digest, so the permission pin still covers them.
 */
export function isDisclosedOperation(op: ManifestEntry): boolean {
  return !isPortalOperation(op);
}

export const DISCLOSED_OPERATIONS = OPERATIONS.filter(isDisclosedOperation);

/** operation name → entry, disclosed operations only. */
export const disclosedOperationsByName = new Map<string, ManifestEntry>(
  DISCLOSED_OPERATIONS.map((op) => [op.name, op])
);

/** The bare operation id (the name without its `module_` prefix). */
export function operationId(op: ManifestEntry): string {
  return op.name.slice(op.module.length + 1);
}

/** The operation's HTTP path: `/{module}/{operationId}` (`/production/cancelJob`). */
export function operationPath(op: ManifestEntry): `/${string}` {
  return `/${op.module}/${operationId(op)}`;
}

/**
 * Whether an operation's HTTP response is the LIST envelope `{ results, count }`
 * or the bare payload.
 *
 * The old contract wrapped everything, which stacked our envelope under every
 * generated client's own result wrapper — callers wrote `res.data.data.field`.
 * The Stripe convention fixes it: single results are the body itself; only list
 * results carry an envelope, because `count` means something there.
 *
 * Decided STATICALLY from the reflected response schema so the runtime shaping
 * (router handler), the reverse mapping (`callOperation`), and the published
 * output schema can never disagree. An operation with no reflected schema is
 * treated as bare — those are `any`/void shapes with no pagination.
 */
export function isListOperation(op: ManifestEntry): boolean {
  const type = (op.responseSchema as { type?: string | string[] } | undefined)
    ?.type;
  return type === "array" || (Array.isArray(type) && type.includes("array"));
}

/**
 * The success body over HTTP. Single results are the payload itself — wrapping
 * everything in `{ data }` stacked our envelope under every generated client's own
 * result wrapper, so callers wrote `res.data.data.field`. Lists keep the envelope
 * because `count` belongs there (the Stripe convention). Keyed off
 * `isListOperation` — the same bit `shapeHttpBody` and `callOperation` use — so the
 * published schema and the runtime behavior cannot drift.
 */
export function outputSchema(op: ManifestEntry): Record<string, unknown> {
  if (!isListOperation(op)) return op.responseSchema ?? {};
  return {
    type: "object",
    properties: {
      results: op.responseSchema ?? {},
      count: {
        type: ["number", "null"],
        description: "Total matching rows, present on paginated reads."
      }
    },
    required: ["results"]
  };
}

/** Shape a dispatch result into the HTTP body `outputSchema` promises. */
export function shapeHttpBody(
  op: ManifestEntry,
  result: { data: unknown; count?: number }
): unknown {
  // `results`, not `data`: generated clients wrap responses in their own `.data`,
  // so an envelope field named `data` reads back as `res.data.data`.
  return isListOperation(op)
    ? { results: result.data, count: result.count ?? null }
    : result.data;
}

/**
 * Reverse of `shapeHttpBody`, for the non-HTTP callers (MCP, agent, workflows)
 * that need DispatchResult semantics back. Keyed off the same static bit — never
 * value sniffing, which would mis-unwrap a payload that happens to carry a
 * `data` key.
 */
export function unshapeHttpBody(
  op: ManifestEntry,
  body: unknown
): { data: unknown; count?: number } {
  if (!isListOperation(op)) return { data: body };
  const envelope = body as { results: unknown; count: number | null };
  return {
    data: envelope.results,
    ...(envelope.count !== null ? { count: envelope.count } : {})
  };
}
