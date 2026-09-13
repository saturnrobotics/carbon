import { z } from "zod";
import {
  commandProposalSchema,
  queryRequestSchema,
  sourceEntityRequestSchema
} from "../contracts";
import { type CapabilityId, QUERY_CAPABILITIES } from "../query/router";

/**
 * The reviewed MCP surface.
 *
 * MCP is a TRANSPORT over handlers that already exist on HTTP — never a second
 * execution path and never the whole generated catalog (plan §1.10). So a tool
 * is not a thing this module implements: it is a POINTER at one HTTP route,
 * carrying the operation name that route's own `verifyWorkforceRequest` call
 * checks and the schema that route's own handler parses. Nothing here can widen
 * either, because both are the same values HTTP uses.
 *
 * A capability reaches MCP only by appearing in this table, which is frozen at
 * load and built from nothing but this module. `packages/knowledge/src/mcp-parity.test.ts`
 * refuses a tool whose operation or schema is not the HTTP route's own.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;
/** The same body cap the app servers enforce ahead of every HTTP handler. */
export const MCP_REQUEST_LIMIT_BYTES = 32_768;

export type McpToolKind = "query" | "command";
export type McpToolDefinition = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The trusted-caller operation the delegated route verifies. Identical to HTTP. */
  readonly operation: string;
  /** The HTTP path this tool delegates to; a service lists a tool only if it mounts that path. */
  readonly path: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly kind: McpToolKind;
  /** The registered query capability a read tool routes to, when it is a read. */
  readonly capability?: CapabilityId;
};

function tool(definition: McpToolDefinition): Readonly<McpToolDefinition> {
  return Object.freeze({
    ...definition,
    inputSchema: Object.freeze(definition.inputSchema)
  });
}

/**
 * `document.locate` and `document.answer` are the two capabilities a reviewed
 * read tool may route to, and `/v1/query` decides which — deterministically,
 * from the request text, before any source, index or model call. The tool
 * cannot name one: it passes the reader's own `QueryRequest` through, so an
 * MCP caller has exactly the routing an HTTP caller has.
 */
const READ_CAPABILITIES: readonly CapabilityId[] = Object.freeze([
  "document.locate",
  "document.answer",
  "source.entities",
  "source.received-manual"
]);

export const MCP_TOOLS: readonly Readonly<McpToolDefinition>[] = Object.freeze([
  tool({
    name: "knowledge_query",
    title: "Search authorized company knowledge",
    description:
      "Locate or answer from documents and live records the caller is already permitted to read. Returns evidence with citations; it never writes.",
    operation: "knowledge.query",
    path: "/v1/query",
    inputSchema: z.toJSONSchema(queryRequestSchema),
    kind: "query"
  }),
  tool({
    name: "knowledge_get_source_entity",
    title: "Open one live record from a registered source",
    description:
      "Read a single record from one registered source through its owning application's API, with the caller's own permission.",
    operation: "knowledge.query",
    path: "/v1/entity",
    inputSchema: z.toJSONSchema(sourceEntityRequestSchema),
    kind: "query"
  }),
  tool({
    name: "knowledge_create_ticket",
    title: "Create a Kanban ticket from an explicit proposal",
    description:
      "Execute an already-resolved ticket command proposal. Requires the ticket-create capability, a permitted board, and a durable idempotency key.",
    operation: "kanban.ticket.create",
    path: "/commands/tickets",
    inputSchema: z.toJSONSchema(commandProposalSchema),
    kind: "command"
  })
]);

/** Every capability a reviewed read tool is allowed to reach. */
export function reviewedReadCapabilities(): readonly CapabilityId[] {
  return READ_CAPABILITIES;
}

/** A capability with no reviewed tool is unreachable over MCP, by construction. */
export function unreviewedCapabilities(): readonly CapabilityId[] {
  return Object.freeze(
    (Object.keys(QUERY_CAPABILITIES) as CapabilityId[]).filter(
      (capability) => !READ_CAPABILITIES.includes(capability)
    )
  );
}

export function mcpToolByName(
  name: string
): Readonly<McpToolDefinition> | undefined {
  return MCP_TOOLS.find((entry) => entry.name === name);
}
