import { UnauthorizedRequestError } from "@carbon/portal/identity.server";
import { describe, expect, it, vi } from "vitest";
import { forwardPortalQuery } from "../services/query-gateway.server";

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
  sourceIapAudience: "/projects/123/services/portal-web",
  accessLevels: ["managed-device"]
};

function request(
  body: unknown = payload,
  origin = "https://portal.example.test"
) {
  return new Request("https://portal.example.test/api/query", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("portal query BFF", () => {
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
    const response = await forwardPortalQuery(request(), {
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

  it("names a step-up denial from the query service and keeps every other denial to its class", async () => {
    const verifyBrowser = vi.fn().mockResolvedValue(verified);
    const forwardingHeaders = vi.fn().mockResolvedValue(new Headers());
    const forward = (upstream: Response) =>
      forwardPortalQuery(request(), {
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

    // A refusal crosses as a refusal. It used to arrive labelled
    // `query_unavailable`, which is what put "Manual search is unavailable" in
    // front of a reader who had simply been denied. The label is still the
    // class alone, whatever the service's own body said.
    for (const [status, code] of [
      [401, "unauthorized"],
      [403, "forbidden"]
    ] as const) {
      const refused = await forward(
        Response.json({ error: "source_unavailable" }, { status })
      );
      expect(refused.status).toBe(status);
      expect(await refused.json()).toEqual({ error: code });
    }

    const spoofed = await forward(
      Response.json({ error: "step_up_required" }, { status: 503 })
    );
    expect(spoofed.status).toBe(503);
    expect(await spoofed.json()).toEqual({ error: "query_unavailable" });
  });

  /**
   * Both the browser check and the forwarding credential throw the one identity
   * denial, and the gateway's blanket catch answered each with 503 — the same
   * answer a dead query service gives. A denied reader was told to come back
   * later, and an operator could not tell the two apart in the response.
   */
  it("separates a denial it raises itself from an upstream that is really down", async () => {
    const forward = (
      overrides: Partial<Parameters<typeof forwardPortalQuery>[1]>
    ) =>
      forwardPortalQuery(request(), {
        queryUrl: "https://query.example.test",
        queryAudience: "https://query.example.test",
        companyId: "company_synthetic",
        verifyBrowser: vi.fn().mockResolvedValue(verified),
        forwardingHeaders: vi.fn().mockResolvedValue(new Headers()),
        fetchImpl: vi
          .fn()
          .mockResolvedValue(Response.json({}, { status: 200 })),
        ...overrides
      });

    const unverified = await forward({
      verifyBrowser: vi.fn().mockRejectedValue(new UnauthorizedRequestError())
    });
    expect(unverified.status).toBe(403);
    expect(await unverified.json()).toEqual({ error: "forbidden" });

    const uncredentialed = await forward({
      forwardingHeaders: vi
        .fn()
        .mockRejectedValue(new UnauthorizedRequestError())
    });
    expect(uncredentialed.status).toBe(403);
    expect(await uncredentialed.json()).toEqual({ error: "forbidden" });

    const unreachable = await forward({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    });
    expect(unreachable.status).toBe(503);
    expect(await unreachable.json()).toEqual({ error: "query_unavailable" });

    const offContract = await forward({
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ kind: "nonsense" }))
    });
    expect(offContract.status).toBe(503);
    expect(await offContract.json()).toEqual({ error: "query_unavailable" });
  });

  it("relays a validated event stream when the browser asks for one, and falls back to JSON", async () => {
    const verifyBrowser = vi.fn().mockResolvedValue(verified);
    const forwardingHeaders = vi.fn().mockResolvedValue(new Headers());
    const evidence = {
      id: "chunk-a",
      sourceId: "source-b",
      sourceRevision: "1",
      title: "Synthetic motor manual",
      sourceUri: "https://portal.example.test/documents/doc-a/versions/v1",
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
      new Request("https://portal.example.test/api/query", {
        method: "POST",
        headers: {
          origin: "https://portal.example.test",
          accept: "application/x-ndjson, application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
    const response = await forwardPortalQuery(streaming(), {
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

    const json = await forwardPortalQuery(streaming(), {
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
    const response = await forwardPortalQuery(incoming, {
      queryUrl: "https://query.example.test",
      queryAudience: "https://query.example.test",
      companyId: "company_synthetic",
      verifyBrowser
    });
    expect(response.status).toBe(status);
    expect(verifyBrowser).not.toHaveBeenCalled();
  });
});
