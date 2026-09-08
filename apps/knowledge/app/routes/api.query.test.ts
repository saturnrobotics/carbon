import { describe, expect, it, vi } from "vitest";
import { forwardKnowledgeQuery } from "../services/query-gateway.server";

const payload = {
  requestId: "request_synthetic",
  text: "open the synthetic motor manual",
  mode: "locate" as const,
  locale: "en-US"
};
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
  body: unknown = payload,
  origin = "https://knowledge.example.test"
) {
  return new Request("https://knowledge.example.test/api/query", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("knowledge query BFF", () => {
  it("authenticates IAP before forwarding a bounded POST with fresh headers", async () => {
    const verifyBrowser = vi.fn().mockResolvedValue(verified);
    const forwardingHeaders = vi
      .fn()
      .mockResolvedValue(new Headers({ authorization: "Bearer fresh" }));
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        requestId: payload.requestId,
        kind: "results",
        evidence: [],
        claims: [],
        message: "No matching records.",
        partial: false
      })
    );
    const response = await forwardKnowledgeQuery(request(), {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser,
      forwardingHeaders,
      fetchImpl
    });

    expect(response.status).toBe(200);
    expect(verifyBrowser).toHaveBeenCalledOnce();
    expect(forwardingHeaders).toHaveBeenCalledWith(
      expect.any(Request),
      verified,
      "company_synthetic",
      "https://query.example.test"
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://query.example.test/v1/query"),
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) })
    );
  });

  it.each([
    ["cross-origin", request(payload, "https://evil.example.test"), 403],
    ["unbounded body", request({ ...payload, text: "x".repeat(8_001) }), 422]
  ])("rejects %s before authentication", async (_name, incoming, status) => {
    const verifyBrowser = vi.fn();
    const response = await forwardKnowledgeQuery(incoming, {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser
    });
    expect(response.status).toBe(status);
    expect(verifyBrowser).not.toHaveBeenCalled();
  });
});
