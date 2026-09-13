import { UnauthorizedRequestError } from "@carbon/knowledge/identity.server";
import { describe, expect, it, vi } from "vitest";
import { forwardItemSearch } from "../services/item-gateway.server";

const verified = {
  kind: "iap-browser" as const,
  sourceIdentity: {
    issuer: "https://cloud.google.com/iap",
    subject: "accounts.google.com:100000000000000000001"
  },
  sourceIapAudience: "/projects/123/services/knowledge-web",
  accessLevels: ["managed-device"]
};

function request(
  body: unknown = { search: "motor", limit: 5 },
  origin = "https://knowledge.example.test"
) {
  return new Request("https://knowledge.example.test/api/items", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("knowledge item search BFF", () => {
  it("verifies IAP, forwards a bounded search, and validates the candidates", async () => {
    const verifyBrowser = vi.fn().mockResolvedValue(verified);
    const forwardingHeaders = vi
      .fn()
      .mockResolvedValue(new Headers({ authorization: "Bearer fresh" }));
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        items: [
          {
            id: "item-1",
            readableId: "EM-100",
            name: "Motor",
            revision: "A",
            mpn: null,
            sourceId: "source-carbon"
          }
        ],
        status: "complete"
      })
    );
    const response = await forwardItemSearch(request(), {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser,
      forwardingHeaders,
      fetchImpl
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://query.example.test/v1/items"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ search: "motor", limit: 5 })
      })
    );
    expect(await response.json()).toMatchObject({ status: "complete" });
  });

  it.each([
    ["cross-origin", request(undefined, "https://evil.example.test"), 403],
    ["unbounded search", request({ search: "x".repeat(300) }), 422]
  ])("rejects %s before authentication", async (_name, incoming, status) => {
    const verifyBrowser = vi.fn();
    const response = await forwardItemSearch(incoming, {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser
    });
    expect(response.status).toBe(status);
    expect(verifyBrowser).not.toHaveBeenCalled();
  });

  it.each([
    ["the browser check", "verifyBrowser"],
    ["minting the forwarding credential", "forwardingHeaders"]
  ])("answers a denial from %s as a refusal, not an outage", async (_name, failing) => {
    const denial = vi.fn().mockRejectedValue(new UnauthorizedRequestError());
    const response = await forwardItemSearch(request(), {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser:
        failing === "verifyBrowser"
          ? denial
          : vi.fn().mockResolvedValue(verified),
      forwardingHeaders:
        failing === "forwardingHeaders"
          ? denial
          : vi.fn().mockResolvedValue(new Headers()),
      fetchImpl: vi.fn()
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "items_unavailable"],
    [503, "items_unavailable"]
  ])("crosses an upstream %i as its own class, never the service's code", async (status, code) => {
    const response = await forwardItemSearch(request(), {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser: vi.fn().mockResolvedValue(verified),
      forwardingHeaders: vi.fn().mockResolvedValue(new Headers()),
      // Whatever the service said, only the class crosses: a refusal stays
      // opaque about which library, source or item it concerned.
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "request_limit_exceeded" }, { status })
        )
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it("does not pass an unvalidated gateway response to the browser", async () => {
    const response = await forwardItemSearch(request(), {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser: vi.fn().mockResolvedValue(verified),
      forwardingHeaders: vi.fn().mockResolvedValue(new Headers()),
      fetchImpl: vi
        .fn()
        .mockResolvedValue(Response.json({ items: "not-a-list" }))
    });
    expect(response.status).toBe(503);
  });
});
