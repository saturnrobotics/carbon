import { describe, expect, it } from "vitest";
import { createHandler, isQueryReady } from "./index";

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

describe("manual release production routes", () => {
  it("requires the manual source and identity configuration without a model provider", () => {
    expect(isQueryReady(environment)).toBe(true);
    expect(
      isQueryReady({ ...environment, PORTAL_MANUAL_SOURCE_JSON: "" })
    ).toBe(false);
    expect(
      isQueryReady({
        ...environment,
        PORTAL_RELEASE_PROFILE: "all-features"
      })
    ).toBe(false);
  });

  it("keeps deferred routes disabled even when their old configuration is present", async () => {
    const handler = createHandler({
      ...environment,
      PORTAL_VERTEX_JSON: "{}",
      PORTAL_STT_JSON: "{}",
      // A registry is live configuration now, so it carries a real value; the
      // routes below stay closed whether or not a source is registered.
      PORTAL_SOURCES_JSON: JSON.stringify({
        version: 1,
        sources: [
          {
            id: "carbon-source",
            kind: "carbon",
            origin: "https://erp.example",
            audience: "erp-receiver-audience"
          }
        ]
      }),
      PORTAL_ACTIONS_ORIGIN: "https://actions.example.com"
    });
    for (const path of [
      "/v1/transcribe",
      "/v1/propose-command",
      "/v1/commands",
      "/v1/sources/manuals/entities/item",
      "/v1/entity"
    ]) {
      const response = await handler(
        new Request(`https://query.example.com${path}`, { method: "POST" })
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });
});
