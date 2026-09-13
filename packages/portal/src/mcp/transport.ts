import {
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER
} from "../identity.server";
import {
  MCP_PROTOCOL_VERSION,
  MCP_REQUEST_LIMIT_BYTES,
  MCP_TOOLS,
  type McpToolDefinition,
  mcpToolByName
} from "./surface";

/**
 * MCP over HTTP, as a delegating transport.
 *
 * Every tool call is turned into the SAME `Request` the HTTP route would have
 * received and handed to the SAME handler the service mounts at that path. So
 * identity verification, caller authorization, budgets, rate limits and
 * idempotency are not reimplemented here and cannot drift: they run inside the
 * delegate. This module's whole job is the JSON-RPC envelope plus three
 * refusals — an unlisted tool, an unmounted path, and a credential shape MCP
 * does not accept.
 *
 * Authentication is the deployment's ordinary machine pair, presented as
 * HEADERS by the MCP client: a receiver-audience service token in
 * `authorization`, the employee's signed evidence in `x-portal-user-evidence`,
 * and the company in `x-portal-company-id`. A browser IAP session cookie is
 * NOT an MCP auth protocol — cookies are never read as a credential and never
 * forwarded to the delegate, so an MCP client that only has a browser session
 * is refused rather than silently acting as someone.
 */
export type McpRouteTable = Readonly<
  Record<string, (request: Request) => Promise<Response>>
>;

export type McpHandlerOptions = {
  /** Absent or false leaves the transport unmounted: every request is a 404. */
  enabled: boolean;
  /** The service's own HTTP dispatch table: path → the handler it already mounts. */
  routes: McpRouteTable;
  serverName: string;
};

/** Copied onto the delegated request; nothing else crosses, cookies least of all. */
const FORWARDED_HEADERS = [
  "authorization",
  PORTAL_USER_EVIDENCE_HEADER,
  PORTAL_COMPANY_HEADER,
  "content-type",
  "accept-language"
] as const;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200
): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status, headers: { "cache-control": "no-store" } }
  );
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}

/**
 * The credential pair. A request carrying only a cookie is unauthenticated
 * here even though the same browser would be admitted at the portal: MCP has
 * no CSRF protection and no origin, so a cookie must never be a credential.
 */
function hasMachinePair(request: Request): boolean {
  return (
    request.headers.get("authorization")?.startsWith("Bearer ") === true &&
    !!request.headers.get(PORTAL_USER_EVIDENCE_HEADER)?.trim() &&
    !!request.headers.get(PORTAL_COMPANY_HEADER)?.trim()
  );
}

function delegatedRequest(
  request: Request,
  tool: Readonly<McpToolDefinition>,
  argumentsValue: unknown
): Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  // A buffered JSON answer, never the NDJSON stream: an MCP result is one value.
  headers.set("accept", "application/json");
  return new Request(new URL(tool.path, new URL(request.url).origin), {
    method: "POST",
    headers,
    body: JSON.stringify(argumentsValue ?? {}),
    signal: request.signal
  });
}

/** The tools this service can actually serve: a tool whose path is unmounted is invisible. */
export function mountedTools(
  routes: McpRouteTable
): readonly Readonly<McpToolDefinition>[] {
  return MCP_TOOLS.filter((tool) => tool.path in routes);
}

export function createMcpHandler(
  options: McpHandlerOptions
): (request: Request) => Promise<Response> {
  const tools = mountedTools(options.routes);
  return async (request: Request): Promise<Response> => {
    if (!options.enabled) return notFound();
    if (request.method !== "POST")
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const body = await request.text();
    if (new TextEncoder().encode(body).length > MCP_REQUEST_LIMIT_BYTES)
      return Response.json({ error: "request_too_large" }, { status: 413 });
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return rpcError(null, PARSE_ERROR, "Invalid JSON");
    }
    if (!message || typeof message !== "object" || Array.isArray(message))
      return rpcError(null, INVALID_REQUEST, "Invalid request");
    const envelope = message as Record<string, unknown>;
    const id: JsonRpcId =
      typeof envelope.id === "string" || typeof envelope.id === "number"
        ? envelope.id
        : null;
    if (envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string")
      return rpcError(id, INVALID_REQUEST, "Invalid request");
    const method = envelope.method;

    if (method === "initialize")
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: options.serverName, version: "0.0.0" }
      });
    if (method.startsWith("notifications/"))
      return new Response(null, { status: 202 });

    // Everything past this point reads company data, so it needs the pair the
    // HTTP routes need. The refusal is the same shape a denied HTTP call gets:
    // a code, and nothing about what exists.
    if (!hasMachinePair(request))
      return Response.json({ error: "unauthorized" }, { status: 401 });

    if (method === "tools/list")
      return rpcResult(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      });
    if (method !== "tools/call")
      return rpcError(id, METHOD_NOT_FOUND, "Unsupported method");

    const parameters =
      envelope.params && typeof envelope.params === "object"
        ? (envelope.params as Record<string, unknown>)
        : {};
    const name = typeof parameters.name === "string" ? parameters.name : "";
    const tool = mcpToolByName(name);
    const delegate = tool ? options.routes[tool.path] : undefined;
    // An unreviewed tool and an unmounted one are one refusal: the transport
    // never reaches anything but this service's own table.
    if (!tool || !delegate) return rpcError(id, INVALID_PARAMS, "Unknown tool");

    const response = await delegate(
      delegatedRequest(request, tool, parameters.arguments)
    );
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const code =
        payload &&
        typeof payload === "object" &&
        typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : "request_failed";
      // The delegate's own status is the verdict; MCP adds no detail to it.
      return rpcError(id, INVALID_PARAMS, code, response.status);
    }
    return rpcResult(id, {
      content: [{ type: "text", text }],
      ...(payload && typeof payload === "object"
        ? { structuredContent: payload }
        : {}),
      isError: false
    });
  };
}
