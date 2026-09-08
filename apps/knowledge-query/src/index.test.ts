import { describe, expect, it } from "vitest";
import { createHandler, isQueryReady } from "./index";

const environment = {
  KNOWLEDGE_BUSINESS_TIMEZONE: "UTC",
  KNOWLEDGE_PORTAL_ORIGIN: "https://portal.example.com",
  KNOWLEDGE_READ_DATABASE_URL: "postgresql://unused@127.0.0.1:59999/unused",
  KNOWLEDGE_REDIS_URL: "redis://127.0.0.1:59998",
  KNOWLEDGE_MANUAL_SOURCE_JSON: JSON.stringify({
    sourceId: "manuals",
    displayName: "Manual library"
  }),
  KNOWLEDGE_TRUSTED_CALLERS_JSON: JSON.stringify({
    version: 1,
    receiver: { id: "query", audience: "query-audience" },
    callers: [
      {
        callerId: "web",
        serviceAccountSubject: "web-subject",
        sourceIapAudience: "iap-audience",
        operations: ["knowledge.query"],
        capabilities: ["knowledge.read"],
        requiredAccessLevels: []
      }
    ]
  })
};

describe("manual release production routes", () => {
  it("requires the manual source and identity configuration without a model provider", () => {
    expect(isQueryReady(environment)).toBe(true);
    expect(
      isQueryReady({ ...environment, KNOWLEDGE_MANUAL_SOURCE_JSON: "" })
    ).toBe(false);
    expect(
      isQueryReady({
        ...environment,
        KNOWLEDGE_RELEASE_PROFILE: "all-features"
      })
    ).toBe(false);
  });

  it("keeps deferred routes disabled even when their old configuration is present", async () => {
    const handler = createHandler({
      ...environment,
      KNOWLEDGE_VERTEX_JSON: "{}",
      KNOWLEDGE_STT_JSON: "{}",
      KNOWLEDGE_SOURCES_JSON: "{}",
      KNOWLEDGE_ACTIONS_ORIGIN: "https://actions.example.com"
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
