import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  exceedsToolInputElements,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_MAX_TOOL_INPUT_ELEMENTS,
  MCP_SERVER_LIMITS,
  MCP_TRANSPORT_LIMITS
} from "./limits";

describe("exceedsToolInputElements", () => {
  it("counts array elements and object members at every depth", () => {
    // 2 members + 3 elements + 1 member = 6
    const value = { a: [1, 2, { b: null }], c: "x" };
    expect(exceedsToolInputElements(value, 6)).toBe(false);
    expect(exceedsToolInputElements(value, 5)).toBe(true);
  });

  it("ignores scalars", () => {
    expect(exceedsToolInputElements("x".repeat(10_000), 1)).toBe(false);
    expect(exceedsToolInputElements(null, 1)).toBe(false);
  });

  it("defaults to the MCP element limit", () => {
    const atLimit = Array.from(
      { length: MCP_MAX_TOOL_INPUT_ELEMENTS },
      () => 0
    );
    expect(exceedsToolInputElements(atLimit)).toBe(false);
    expect(exceedsToolInputElements([...atLimit, 0])).toBe(true);
  });
});

// The same wiring as /api/mcp: one stateless JSON transport per request.
async function post(body: string) {
  const server = new McpServer(
    { name: "limits-test", version: "0.0.0" },
    { ...MCP_SERVER_LIMITS }
  );
  server.registerTool(
    "echo",
    { inputSchema: z.object({ arguments: z.any() }) },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] })
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    ...MCP_TRANSPORT_LIMITS
  });
  await server.connect(transport);
  return transport.handleRequest(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body
    })
  );
}

function callEcho(args: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "echo", arguments: { arguments: args } }
  });
}

describe("MCP SDK honours the configured limits", () => {
  it("answers 413 for a body over the cap", async () => {
    const response = await post(
      callEcho("x".repeat(MCP_MAX_REQUEST_BODY_BYTES))
    );
    expect(response.status).toBe(413);
  });

  it("rejects tool arguments over the element limit", async () => {
    // The wrapper object adds one member.
    const fits = Array.from(
      { length: MCP_MAX_TOOL_INPUT_ELEMENTS - 1 },
      () => 0
    );
    const ok = await (await post(callEcho(fits))).json();
    expect(ok.result.isError).toBeFalsy();

    const over = await (await post(callEcho([...fits, 0]))).json();
    expect(over.result.isError).toBe(true);
    expect(JSON.stringify(over)).toContain(
      `maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`
    );
  });
});
