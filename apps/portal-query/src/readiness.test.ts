import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isQueryReady, startServer } from "./index";

const complete = {
  PORTAL_BUSINESS_TIMEZONE: "UTC",
  PORTAL_ORIGIN: "https://portal.example",
  PORTAL_READ_DATABASE_URL: "postgresql://synthetic",
  PORTAL_REDIS_URL: "rediss://cache.example",
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

describe("query readiness", () => {
  it("fails closed when any advertised query capability is not configured", () => {
    expect(isQueryReady(complete)).toBe(true);
    expect(isQueryReady({ ...complete, PORTAL_REDIS_URL: "" })).toBe(false);
  });

  it("returns an unhealthy probe response before configuration is complete", async () => {
    const server = startServer(0, async () => Response.json({}), {});
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(503);
    } finally {
      server.close();
    }
  });
});
