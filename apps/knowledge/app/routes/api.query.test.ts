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

  it("names a step-up denial from the query service and keeps other denials generic", async () => {
    const verifyBrowser = vi.fn().mockResolvedValue(verified);
    const forwardingHeaders = vi.fn().mockResolvedValue(new Headers());
    const forward = (upstream: Response) =>
      forwardKnowledgeQuery(request(), {
        queryUrl: "https://query.example.test",
        queryAudience: "https://query.example.test",
        companyId: "company_synthetic",
        verifyBrowser,
        forwardingHeaders,
        fetchImpl: vi.fn().mockResolvedValue(upstream)
      });

    const stepUp = await forward(
      Response.json({ error: "step_up_required" }, { status: 403 })
    );
    expect(stepUp.status).toBe(403);
    expect(await stepUp.json()).toEqual({ error: "step_up_required" });
    expect(stepUp.headers.get("cache-control")).toBe("no-store");

    const forbidden = await forward(
      Response.json({ error: "forbidden" }, { status: 403 })
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "query_unavailable" });

    const spoofed = await forward(
      Response.json({ error: "step_up_required" }, { status: 503 })
    );
    expect(spoofed.status).toBe(503);
    expect(await spoofed.json()).toEqual({ error: "query_unavailable" });
  });

  it("relays a validated event stream when the browser asks for one, and falls back to JSON", async () => {
    const verifyBrowser = vi.fn().mockResolvedValue(verified);
    const forwardingHeaders = vi.fn().mockResolvedValue(new Headers());
    const evidence = {
      id: "chunk-a",
      sourceId: "source-b",
      sourceRevision: "1",
      title: "Synthetic motor manual",
      sourceUri: "https://knowledge.example.test/documents/doc-a/versions/v1",
      observedAt: "2026-09-01T00:00:00Z",
      policyVersion: "1",
      freshness: "current"
    };
    const result = {
      requestId: payload.requestId,
      kind: "results",
      evidence: [evidence],
      claims: [],
      message: "",
      partial: false
    };
    const upstreamLines = [
      JSON.stringify({
        type: "progress",
        stage: "retrieval",
        state: "started"
      }),
      JSON.stringify({ type: "evidence", evidence: [evidence] }),
      JSON.stringify({ type: "thinking", text: "let me think" }),
      JSON.stringify({ type: "result", result })
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`${upstreamLines.join("\n")}\n`, {
        headers: { "content-type": "application/x-ndjson" }
      })
    );
    const streaming = () =>
      new Request("https://knowledge.example.test/api/query", {
        method: "POST",
        headers: {
          origin: "https://knowledge.example.test",
          accept: "application/x-ndjson, application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
    const response = await forwardKnowledgeQuery(streaming(), {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser,
      forwardingHeaders,
      fetchImpl
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const sent = fetchImpl.mock.calls[0]?.[1] as { headers: Headers };
    expect(sent.headers.get("accept")).toBe("application/x-ndjson");
    const relayed = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    // The two valid events pass; the event outside the contract ends the
    // stream with a coded error, and the result after it is never relayed.
    expect(relayed).toEqual([
      { type: "progress", stage: "retrieval", state: "started" },
      { type: "evidence", evidence: [evidence] },
      { type: "error", error: "query_unavailable" }
    ]);

    const json = await forwardKnowledgeQuery(streaming(), {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser,
      forwardingHeaders,
      fetchImpl: vi.fn().mockResolvedValue(Response.json(result))
    });
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.json()).toEqual(result);
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
