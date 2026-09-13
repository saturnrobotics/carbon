import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  commandProposalSchema,
  queryRequestSchema,
  sourceEntityRequestSchema
} from "./contracts";
import {
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER
} from "./identity.server";
import { isMcpEnabled, MCP_ENABLED_VARIABLE } from "./mcp/deployment";
import {
  MCP_PROTOCOL_VERSION,
  MCP_REQUEST_LIMIT_BYTES,
  MCP_TOOLS,
  reviewedReadCapabilities,
  unreviewedCapabilities
} from "./mcp/surface";
import { createMcpHandler, mountedTools } from "./mcp/transport";
import { QUERY_CAPABILITIES } from "./query/router";

/**
 * HTTP/MCP permission parity.
 *
 * The claim under test is narrow and absolute: for one actor and one caller,
 * MCP can reach no operation HTTP does not expose, and can return no byte HTTP
 * would not have returned. The proof is structural — every tool delegates to
 * the route table the service already mounts — plus these differential cases,
 * which run the same actor down both paths and compare.
 */
const service = "https://query.example";
const company = "cmp_alpha";

/**
 * A stand-in for the app's HTTP dispatch table. Each entry records what it was
 * called with and answers from `answer`, so a test can compare the two paths
 * byte for byte without a database, a provider or a source.
 */
function routeTable(
  answer: (path: string, body: unknown, request: Request) => Response
) {
  const calls: Array<{
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  const handler = (path: string) => async (request: Request) => {
    const text = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = text ? JSON.parse(text) : null;
    calls.push({ path, body, headers });
    return answer(path, body, request);
  };
  return {
    calls,
    routes: {
      "/v1/query": handler("/v1/query"),
      "/v1/entity": handler("/v1/entity"),
      "/commands/tickets": handler("/commands/tickets")
    }
  };
}

function credentials(): Record<string, string> {
  return {
    authorization: "Bearer service-token-for-receiver-audience",
    [PORTAL_USER_EVIDENCE_HEADER]: "iap-assertion",
    [PORTAL_COMPANY_HEADER]: company
  };
}

function call(
  name: string,
  argumentsValue: unknown,
  headers: Record<string, string> = credentials(),
  id: number | string = 1
): Request {
  return new Request(`${service}/v1/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: argumentsValue }
    })
  });
}

function rpc(
  method: string,
  headers: Record<string, string> = credentials()
): Request {
  return new Request(`${service}/v1/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method })
  });
}

const query = {
  requestId: "req-1",
  text: "torque spec for the spindle",
  mode: "locate" as const,
  locale: "en"
};
const ticket = {
  id: "cmd-1",
  version: 1 as const,
  action: "kanban.ticket.create" as const,
  idempotencyKey: "idem-1",
  payloadHash: "a".repeat(64),
  payload: {
    boardId: "board-1",
    columnId: "column-1",
    title: "Surface grind the frame",
    dueDate: "2026-10-01"
  }
};

describe("the MCP surface is a pointer at HTTP, not a second catalog", () => {
  it("names, for every tool, the operation and schema its HTTP route already uses", () => {
    // Each entry is the operation the route's own `verifyWorkforceRequest`
    // call names and the schema its own handler parses.
    const httpSurface = new Map<string, { operation: string; schema: unknown }>(
      [
        [
          "/v1/query",
          {
            operation: "portal.query",
            schema: z.toJSONSchema(queryRequestSchema)
          }
        ],
        [
          "/v1/entity",
          {
            operation: "portal.query",
            schema: z.toJSONSchema(sourceEntityRequestSchema)
          }
        ],
        [
          "/commands/tickets",
          {
            operation: "kanban.ticket.create",
            schema: z.toJSONSchema(commandProposalSchema)
          }
        ]
      ]
    );
    for (const tool of MCP_TOOLS) {
      const route = httpSurface.get(tool.path);
      expect(
        route,
        `${tool.name} points at an unknown HTTP path`
      ).toBeDefined();
      expect(tool.operation).toBe(route?.operation);
      expect(tool.inputSchema).toEqual(route?.schema);
    }
    expect(Object.isFrozen(MCP_TOOLS)).toBe(true);
    expect(() => {
      (MCP_TOOLS as unknown as Array<unknown>).push({ name: "smuggled" });
    }).toThrow();
  });
  it("exposes no tool for an unreviewed capability, and no command beyond the reviewed one", () => {
    const reviewed = reviewedReadCapabilities();
    const unreviewed = unreviewedCapabilities();
    expect([...reviewed, ...unreviewed].sort()).toEqual(
      Object.keys(QUERY_CAPABILITIES).sort()
    );
    expect(unreviewed).toContain("command.propose");
    // Nothing in the surface may reach a capability outside the reviewed set.
    for (const tool of MCP_TOOLS)
      if (tool.capability) expect(reviewed).toContain(tool.capability);
    expect(MCP_TOOLS.filter((tool) => tool.kind === "command")).toHaveLength(1);
  });
  it("lists only the tools the calling service actually mounts", async () => {
    const { routes } = routeTable(() => Response.json({ ok: true }));
    const readOnly = {
      "/v1/query": routes["/v1/query"],
      "/v1/entity": routes["/v1/entity"]
    };
    expect(mountedTools(readOnly).map((tool) => tool.name)).toEqual([
      "portal_query",
      "portal_get_source_entity"
    ]);
    const handler = createMcpHandler({
      enabled: true,
      routes: readOnly,
      serverName: "portal-query"
    });
    const listed = await (await handler(rpc("tools/list"))).json();
    expect(
      (listed.result.tools as Array<{ name: string }>).map((tool) => tool.name)
    ).not.toContain("portal_create_ticket");
    // A tool this service does not mount is not callable through it either.
    const refused = await handler(call("portal_create_ticket", ticket));
    expect(await refused.json()).toMatchObject({
      error: { code: -32602, message: "Unknown tool" }
    });
    expect(refused.status).toBe(200);
  });
});

describe("MCP cannot expose more data than HTTP for the same actor and caller", () => {
  it("delegates to the identical handler with the identical body, and returns its bytes unchanged", async () => {
    const answer = Response.json({
      kind: "results",
      evidence: [{ id: "chunk-1" }]
    });
    const http = routeTable(() => answer.clone());
    const mcp = routeTable(() => answer.clone());
    const httpBody = await (
      await http.routes["/v1/query"](
        new Request(`${service}/v1/query`, {
          method: "POST",
          headers: credentials(),
          body: JSON.stringify(query)
        })
      )
    ).text();
    const handler = createMcpHandler({
      enabled: true,
      routes: mcp.routes,
      serverName: "portal-query"
    });
    const result = await (await handler(call("portal_query", query))).json();
    // The MCP result carries the HTTP response body and nothing besides.
    expect(result.result.content).toEqual([{ type: "text", text: httpBody }]);
    expect(result.result.structuredContent).toEqual(JSON.parse(httpBody));
    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0]?.path).toBe("/v1/query");
    expect(mcp.calls[0]?.body).toEqual(http.calls[0]?.body);
  });
  it("forwards the verified credential pair and never a cookie", async () => {
    const { calls, routes } = routeTable(() => Response.json({ ok: true }));
    const handler = createMcpHandler({
      enabled: true,
      routes,
      serverName: "portal-query"
    });
    await handler(
      call("portal_query", query, {
        ...credentials(),
        cookie: "GCP_IAAP_AUTH_TOKEN=browser-session",
        "x-portal-actor-id": "someone-else",
        "x-serverless-authorization": "Bearer stripped",
        "x-goog-iap-jwt-assertion": "forged"
      })
    );
    const forwarded = calls[0]?.headers ?? {};
    expect(forwarded.authorization).toBe(credentials().authorization);
    expect(forwarded[PORTAL_USER_EVIDENCE_HEADER]).toBe("iap-assertion");
    expect(forwarded[PORTAL_COMPANY_HEADER]).toBe(company);
    for (const header of [
      "cookie",
      "x-portal-actor-id",
      "x-serverless-authorization",
      "x-goog-iap-jwt-assertion"
    ])
      expect(forwarded[header]).toBeUndefined();
  });
  it("refuses a browser cookie as an MCP credential before reaching any handler", async () => {
    const { calls, routes } = routeTable(() => Response.json({ ok: true }));
    const handler = createMcpHandler({
      enabled: true,
      routes,
      serverName: "portal-query"
    });
    const incomplete: Array<Record<string, string>> = [
      { cookie: "GCP_IAAP_AUTH_TOKEN=browser-session" },
      { authorization: "Bearer only-a-service-token" },
      {
        authorization: "Bearer service-token",
        [PORTAL_USER_EVIDENCE_HEADER]: "iap-assertion"
      }
    ];
    for (const headers of incomplete) {
      const response = await handler(call("portal_query", query, headers));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    // tools/list is company data too, so it takes the same pair.
    expect((await handler(rpc("tools/list", {}))).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it("passes a denial through as the delegate's own status with no added detail", async () => {
    const denial = () => Response.json({ error: "forbidden" }, { status: 403 });
    const http = routeTable(denial);
    const mcp = routeTable(denial);
    const httpResponse = await http.routes["/v1/query"](
      new Request(`${service}/v1/query`, {
        method: "POST",
        headers: credentials(),
        body: JSON.stringify(query)
      })
    );
    const handler = createMcpHandler({
      enabled: true,
      routes: mcp.routes,
      serverName: "portal-query"
    });
    const response = await handler(call("portal_query", query));
    expect(httpResponse.status).toBe(403);
    expect(response.status).toBe(403);
    const payload = await response.json();
    expect(payload.error.message).toBe("forbidden");
    // No evidence, no counts, no names: the refusal says only that it refused.
    expect(JSON.stringify(payload)).not.toContain("chunk");
    expect(payload.result).toBeUndefined();
  });
  it("cannot reach a path outside the service's table, whatever the tool name says", async () => {
    const { calls, routes } = routeTable(() => Response.json({ ok: true }));
    const handler = createMcpHandler({
      enabled: true,
      routes,
      serverName: "portal-query"
    });
    for (const name of [
      "portal_admin_export",
      "/v1/identity",
      "../v1/identity",
      ""
    ]) {
      const response = await handler(call(name, {}));
      expect(await response.json()).toMatchObject({
        error: { message: "Unknown tool" }
      });
    }
    expect(calls).toEqual([]);
  });
});

describe("MCP cannot execute more operations than HTTP", () => {
  it("runs a command through the same handler, so its idempotency key decides the outcome", async () => {
    const executions: string[] = [];
    const execute = (_path: string, body: unknown) => {
      const proposal = body as typeof ticket;
      const replayed = executions.includes(proposal.idempotencyKey);
      if (!replayed) executions.push(proposal.idempotencyKey);
      return Response.json(
        { ticketId: "tkt-1", replayed },
        { status: replayed ? 200 : 201 }
      );
    };
    const { calls, routes } = routeTable(execute);
    const handler = createMcpHandler({
      enabled: true,
      routes,
      serverName: "portal-actions"
    });
    const first = await (
      await handler(call("portal_create_ticket", ticket, credentials(), 1))
    ).json();
    const second = await (
      await handler(call("portal_create_ticket", ticket, credentials(), 2))
    ).json();
    expect(first.result.structuredContent).toEqual({
      ticketId: "tkt-1",
      replayed: false
    });
    expect(second.result.structuredContent).toEqual({
      ticketId: "tkt-1",
      replayed: true
    });
    expect(executions).toEqual(["idem-1"]);
    // The key and payload reached the handler untouched, both times.
    expect(calls.map((entry) => entry.body)).toEqual([ticket, ticket]);
  });
  it("has no method beyond initialize, notifications, tools/list and tools/call", async () => {
    const { calls, routes } = routeTable(() => Response.json({ ok: true }));
    const handler = createMcpHandler({
      enabled: true,
      routes,
      serverName: "portal-query"
    });
    const initialize = await (await handler(rpc("initialize", {}))).json();
    expect(initialize.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect((await handler(rpc("notifications/initialized"))).status).toBe(202);
    for (const method of [
      "resources/list",
      "resources/read",
      "prompts/list",
      "completion/complete",
      "logging/setLevel",
      "sampling/createMessage"
    ]) {
      const response = await handler(rpc(method));
      expect(await response.json()).toMatchObject({
        error: { code: -32601 }
      });
    }
    expect(calls).toEqual([]);
  });
  it("applies the same request-size and method limits the HTTP servers apply", async () => {
    const { calls, routes } = routeTable(() => Response.json({ ok: true }));
    const handler = createMcpHandler({
      enabled: true,
      routes,
      serverName: "portal-query"
    });
    const oversized = await handler(
      call("portal_query", {
        ...query,
        text: "x".repeat(MCP_REQUEST_LIMIT_BYTES)
      })
    );
    expect(oversized.status).toBe(413);
    const wrongMethod = await handler(
      new Request(`${service}/v1/mcp`, { method: "GET" })
    );
    expect(wrongMethod.status).toBe(405);
    const malformed = await handler(
      new Request(`${service}/v1/mcp`, {
        method: "POST",
        headers: credentials(),
        body: "{"
      })
    );
    expect((await malformed.json()).error.code).toBe(-32700);
    expect(calls).toEqual([]);
  });
});

describe("MCP deployment is disabled by default", () => {
  it("answers 404 for every request while the transport is not enabled", async () => {
    const { calls, routes } = routeTable(() => Response.json({ ok: true }));
    const handler = createMcpHandler({
      enabled: false,
      routes,
      serverName: "portal-query"
    });
    for (const request of [
      rpc("initialize", {}),
      rpc("tools/list"),
      call("portal_query", query)
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(calls).toEqual([]);
  });
  it("requires the exact flag AND a release profile past the approved manual boundary", () => {
    expect(isMcpEnabled({})).toBe(false);
    expect(isMcpEnabled({ [MCP_ENABLED_VARIABLE]: "true" })).toBe(false);
    expect(
      isMcpEnabled({
        [MCP_ENABLED_VARIABLE]: "true",
        PORTAL_RELEASE_PROFILE: "manual-v1"
      })
    ).toBe(false);
    for (const value of ["1", "yes", "TRUE", " ", "false"])
      expect(
        isMcpEnabled({
          [MCP_ENABLED_VARIABLE]: value,
          PORTAL_RELEASE_PROFILE: "mcp-pilot"
        })
      ).toBe(false);
    expect(
      isMcpEnabled({
        [MCP_ENABLED_VARIABLE]: "true",
        PORTAL_RELEASE_PROFILE: "mcp-pilot"
      })
    ).toBe(true);
  });
});

describe("no alternate execution path exists", () => {
  it("calls exactly one delegate per tool call and never fetches on its own", async () => {
    const fetcher = vi.fn(async () => Response.json({ leaked: true }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const { calls, routes } = routeTable(() => Response.json({ ok: true }));
      const handler = createMcpHandler({
        enabled: true,
        routes,
        serverName: "portal-query"
      });
      await handler(call("portal_query", query));
      await handler(
        call("portal_get_source_entity", {
          sourceId: "cad",
          entityId: "grinder-frame-mk2"
        })
      );
      expect(calls.map((entry) => entry.path)).toEqual([
        "/v1/query",
        "/v1/entity"
      ]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
