import { describe, expect, it, vi } from "vitest";
import { forwardCommandProposal } from "./command-proposal-gateway.server";

describe("command proposal BFF", () => {
  it("requires IAP and forwards a bounded explicit request with a fresh identity envelope", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ kind: "clarification" }));
    const request = new Request(
      "https://knowledge.example/api/propose-command",
      {
        method: "POST",
        headers: {
          origin: "https://knowledge.example",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requestId: "p-1",
          text: "Create a ticket",
          locale: "en-US"
        })
      }
    );
    const response = await forwardCommandProposal(request, {
      queryUrl: "https://query.example",
      queryAudience: "query-audience",
      companyId: "company-a",
      verifyBrowser: vi.fn().mockResolvedValue({ kind: "iap-browser" }),
      forwardingHeaders: vi.fn().mockResolvedValue(
        new Headers({
          authorization: "Bearer fresh",
          "x-portal-user-evidence": "iap"
        })
      ),
      fetchImpl
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://query.example/v1/propose-command"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          requestId: "p-1",
          text: "Create a ticket",
          locale: "en-US"
        })
      })
    );
  });
});
