import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isActionsReady, startServer } from "./index";

const complete = {
  KNOWLEDGE_CARBON_SOURCE_AUDIENCE: "carbon-audience",
  KNOWLEDGE_CARBON_SOURCE_URL: "https://carbon.example",
  KNOWLEDGE_IDENTITY_RESOLVER_AUDIENCE: "identity-audience",
  KNOWLEDGE_IDENTITY_RESOLVER_URL: "https://query.example",
  KNOWLEDGE_KANBAN_SOURCE_AUDIENCE: "kanban-audience",
  KNOWLEDGE_KANBAN_SOURCE_ID: "kanban",
  KNOWLEDGE_KANBAN_SOURCE_URL: "https://kanban.example",
  KNOWLEDGE_TRUSTED_CALLERS_JSON: "{}"
};

describe("actions readiness", () => {
  it("fails closed unless identity and both command destinations are configured", () => {
    expect(isActionsReady(complete)).toBe(true);
    expect(
      isActionsReady({ ...complete, KNOWLEDGE_KANBAN_SOURCE_URL: "" })
    ).toBe(false);
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
