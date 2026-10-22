import type { McpServerOptions } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * Request limits for /api/mcp (GHSA-46jr-4wx8-v453, GHSA-f897-62hf-6gxq).
 * Both SDK options are off or loose by default, so upgrading alone does not
 * apply them. The route authenticates before the transport reads the body, so
 * these bound what an authenticated caller can make the server parse.
 *
 * - Body: 1 MiB, down from the SDK's 4 MiB default. A call_tool request is
 *   JSON written by a model, usually a few KB; no tool takes file content.
 * - Elements: 10,000 array elements plus object members per tools/call
 *   `arguments`, the advisory's suggested ceiling. It leaves room for
 *   bulk-line writes and rich-text step bodies.
 *
 * Batches over 100 messages get 400 from the SDK itself (MAX_BATCH_SIZE).
 */
export const MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 10_000;

export const MCP_TRANSPORT_LIMITS = {
  maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES
} satisfies WebStandardStreamableHTTPServerTransportOptions;

export const MCP_SERVER_LIMITS = {
  maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS
} satisfies McpServerOptions;

/**
 * True when `value` holds more than `max` array elements plus object members,
 * counted the way the SDK counts for `maxToolInputElements`. call_tool uses it
 * on `arguments` sent as a JSON string: the SDK counts that string as one
 * value, so the parsed result needs its own check.
 */
export function exceedsToolInputElements(
  value: unknown,
  max: number = MCP_MAX_TOOL_INPUT_ELEMENTS
): boolean {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (++count > max) return true;
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
  return false;
}
