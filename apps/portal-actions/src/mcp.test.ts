import { describe, expect, it, vi } from "vitest";
import { createHandler } from "./index";
import { createActionsMcpHandler } from "./mcp";

const environment = {
  PORTAL_CARBON_SOURCE_AUDIENCE: "carbon-audience",
  PORTAL_CARBON_SOURCE_URL: "https://erp.example.com",
  PORTAL_IDENTITY_RESOLVER_AUDIENCE: "resolver-audience",
  PORTAL_IDENTITY_RESOLVER_URL: "https://query.example.com",
  PORTAL_KANBAN_SOURCE_AUDIENCE: "kanban-audience",
  PORTAL_KANBAN_SOURCE_ID: "kanban",
  PORTAL_KANBAN_SOURCE_URL: "https://kanban.example.com",
  PORTAL_TRUSTED_CALLERS_JSON: JSON.stringify({
    version: 1,
    receiver: { id: "actions", audience: "actions-audience" },
    callers: [
      {
        callerId: "web",
        serviceAccountSubject: "web-subject",
        sourceIapAudience: "iap-audience",
        operations: ["kanban.ticket.create"],
        capabilities: ["kanban.ticket.create"],
        requiredAccessLevels: []
      }
    ]
  })
};

const credentials = {
  "content-type": "application/json",
  authorization: "Bearer service-token",
  "x-portal-user-evidence": "iap-assertion",
  "x-portal-company-id": "cmp_alpha"
};

function rpc(method: string, params?: unknown): Request {
  return new Request("https://actions.example.com/mcp", {
    method: "POST",
    headers: credentials,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
}

describe("the command service's MCP mount", () => {
  it("is 404 by default, including with the flag alone", async () => {
    for (const extra of [{}, { PORTAL_MCP_ENABLED: "true" }]) {
      const response = await createHandler({ ...environment, ...extra })(
        rpc("initialize")
      );
      expect(response.status).toBe(404);
    }
  });
  it("exposes only the reviewed ticket command, and runs it through the HTTP handler", async () => {
    const ticketRoute = vi.fn(async (request: Request) => {
      // The delegated request is the ordinary command request: same headers.
      expect(request.headers.get("x-portal-company-id")).toBe("cmp_alpha");
      expect(await request.json()).toMatchObject({ id: "cmd-1" });
      return Response.json(
        { ticketId: "tkt-1", replayed: false },
        {
          status: 201
        }
      );
    });
    const handler = createActionsMcpHandler({
      environment: {
        PORTAL_MCP_ENABLED: "true",
        PORTAL_RELEASE_PROFILE: "mcp-pilot"
      },
      routes: { "/commands/tickets": ticketRoute }
    });
    const listed = await (await handler(rpc("tools/list"))).json();
    expect(
      (listed.result.tools as Array<{ name: string }>).map((tool) => tool.name)
    ).toEqual(["portal_create_ticket"]);
    const called = await (
      await handler(
        rpc("tools/call", {
          name: "portal_create_ticket",
          arguments: { id: "cmd-1" }
        })
      )
    ).json();
    expect(called.result.structuredContent).toEqual({
      ticketId: "tkt-1",
      replayed: false
    });
    expect(ticketRoute).toHaveBeenCalledOnce();
  });
});
