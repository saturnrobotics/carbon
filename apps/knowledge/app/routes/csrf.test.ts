import { describe, expect, it, vi } from "vitest";
import { forwardIntakeRequest } from "../modules/intake/intake.service";
import { forwardKnowledgeQuery } from "../services/query-gateway.server";
import { forwardTicketCommand } from "./api.commands";

const origin = "https://knowledge.example.test";
const environment = {
  KNOWLEDGE_WEB_ORIGIN: origin,
  KNOWLEDGE_WORKER_URL: "https://worker.example.test",
  KNOWLEDGE_WORKER_AUDIENCE: "https://worker.example.test",
  KNOWLEDGE_WEB_IAP_AUDIENCE: "/projects/000/global/backendServices/portal"
};

function mutation(headers: Record<string, string>, method = "POST") {
  return new Request(`${origin}/intake`, {
    method,
    headers,
    body:
      method === "GET" || method === "HEAD" ? undefined : "document=synthetic"
  });
}

describe("CSRF and origin checks on mutation routes", () => {
  it.each([
    ["a cross-site origin", { origin: "https://evil.example.test" }],
    ["a missing origin", {}],
    ["a null origin", { origin: "null" }]
  ])("rejects an intake mutation with %s before identity or the worker", async (_name, headers) => {
    const fetchImpl = vi.fn();
    await expect(
      forwardIntakeRequest({
        request: mutation(headers),
        companyId: "company_synthetic",
        workerPath: "/v1/intake",
        environment,
        fetchImpl
      })
    ).rejects.toThrow("Cross-origin knowledge mutation rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("applies the same check to a DELETE forwarded from a form post", async () => {
    const fetchImpl = vi.fn();
    await expect(
      forwardIntakeRequest({
        request: mutation({ origin: "https://evil.example.test" }),
        companyId: "company_synthetic",
        workerPath: "/v1/documents/doc",
        method: "DELETE",
        environment,
        fetchImpl
      })
    ).rejects.toThrow("Cross-origin knowledge mutation rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gates a GET download on verified identity, not on an origin header", async () => {
    const fetchImpl = vi.fn();
    await expect(
      forwardIntakeRequest({
        request: mutation({}, "GET"),
        companyId: "company_synthetic",
        workerPath: "/v1/documents/doc/versions/version",
        environment,
        fetchImpl
      })
    ).rejects.toThrow("unauthorized workforce request");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a cross-site query before verifying the browser", async () => {
    const verifyBrowser = vi.fn();
    const response = await forwardKnowledgeQuery(
      new Request(`${origin}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "r",
          text: "manual",
          mode: "locate",
          locale: "en"
        })
      }),
      {
        queryUrl: "https://query.example.test",
        queryAudience: "q",
        companyId: "c",
        verifyBrowser
      }
    );
    expect(response.status).toBe(403);
    expect(verifyBrowser).not.toHaveBeenCalled();
  });

  it("rejects a cross-site ticket command before verifying the browser", async () => {
    const verifyWorkforce = vi.fn();
    const response = await forwardTicketCommand(
      new Request(`${origin}/api/commands`, {
        method: "POST",
        headers: {
          origin: "https://evil.example.test",
          "content-type": "application/json"
        },
        body: "{}"
      }),
      {
        actionsUrl: "https://actions.example.test",
        verifyWorkforce,
        forwardingHeaders: async () => new Headers()
      }
    );
    expect(response.status).toBe(403);
    expect(verifyWorkforce).not.toHaveBeenCalled();
  });
});
