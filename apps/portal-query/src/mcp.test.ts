import { describe, expect, it } from "vitest";
import { createHandler } from "./index";
import { createQueryMcpHandler } from "./mcp";

const environment = {
  PORTAL_BUSINESS_TIMEZONE: "UTC",
  PORTAL_ORIGIN: "https://portal.example.com",
  PORTAL_READ_DATABASE_URL: "postgresql://unused@127.0.0.1:59999/unused",
  PORTAL_REDIS_URL: "redis://127.0.0.1:59998",
  PORTAL_MANUAL_SOURCE_JSON: JSON.stringify({
    sourceId: "manuals",
    displayName: "Manual library"
  }),
  PORTAL_TRUSTED_CALLERS_JSON: JSON.stringify({
    version: 1,
    receiver: { id: "query", audience: "query-audience" },
    callers: [
      {
        callerId: "web",
        serviceAccountSubject: "web-subject",
        sourceIapAudience: "iap-audience",
        operations: ["portal.query"],
        capabilities: ["portal.read"],
        requiredAccessLevels: []
      }
    ]
  })
};

function initialize(): Request {
  return new Request("https://query.example.com/v1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
  });
}

describe("the query service's MCP mount", () => {
  it("stays 404 under the approved manual release, flag or no flag", async () => {
    for (const extra of [
      {},
      { PORTAL_MCP_ENABLED: "true" },
      { PORTAL_MCP_ENABLED: "true", PORTAL_RELEASE_PROFILE: "manual-v1" }
    ]) {
      const response = await createHandler({ ...environment, ...extra })(
        initialize()
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });
  it("serves initialize once the flag and a later release profile are both set", async () => {
    const handler = createQueryMcpHandler({
      environment: {
        PORTAL_MCP_ENABLED: "true",
        PORTAL_RELEASE_PROFILE: "mcp-pilot"
      },
      routes: { "/v1/query": async () => Response.json({ ok: true }) }
    });
    const response = await handler(initialize());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.serverInfo.name).toBe("portal-query");
    // Only the read route this service mounts is reachable.
    const listed = await (
      await handler(
        new Request("https://query.example.com/v1/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer service-token",
            "x-portal-user-evidence": "iap-assertion",
            "x-portal-company-id": "cmp_alpha"
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
        })
      )
    ).json();
    expect(
      (listed.result.tools as Array<{ name: string }>).map((tool) => tool.name)
    ).toEqual(["portal_query"]);
  });
});
