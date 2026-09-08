import { describe, expect, it, vi } from "vitest";
import { forwardTranscription } from "./api.transcribe";

function request() {
  const form = new FormData();
  form.set(
    "audio",
    new File(["audio-bytes"], "command.wav", { type: "audio/wav" })
  );
  return new Request("https://portal.example/api/transcribe", {
    method: "POST",
    headers: {
      origin: "https://portal.example",
      "x-goog-iap-jwt-assertion": "iap",
      "x-request-id": "transcribe-1"
    },
    body: form
  });
}

describe("voice command transcription forwarding", () => {
  it("authenticates before relaying unchanged multipart bytes to knowledge-query", async () => {
    const verifyBrowser = vi
      .fn()
      .mockResolvedValue({ token: { sub: "google-alice" } });
    const resolveCompanyId = vi.fn().mockResolvedValue("company-a");
    const forwardingHeaders = vi.fn().mockResolvedValue(
      new Headers({
        authorization: "Bearer query-service",
        "x-portal-user-evidence": "iap"
      })
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ text: "Create a ticket" }));
    const source = request();
    const sourceBytes = await source.clone().arrayBuffer();

    const response = await forwardTranscription(source, {
      queryUrl: "https://query.example",
      queryAudience: "query-audience",
      verifyBrowser,
      resolveCompanyId,
      forwardingHeaders,
      fetchImpl
    });

    expect(response.status).toBe(200);
    expect(verifyBrowser).toHaveBeenCalledBefore(resolveCompanyId);
    expect(forwardingHeaders).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-a",
        targetAudience: "query-audience"
      })
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://query.example/v1/transcribe"),
      expect.objectContaining({ method: "POST" })
    );
    const sent = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(sent.headers).toEqual(expect.any(Headers));
    expect((sent.headers as Headers).get("x-request-id")).toBe("transcribe-1");
    expect((sent.headers as Headers).get("x-portal-user-evidence")).toBe("iap");
    expect(Buffer.from(sent.body as ArrayBuffer)).toEqual(
      Buffer.from(sourceBytes)
    );
  });

  it("does not read media or call query when IAP verification fails", async () => {
    const verifyBrowser = vi
      .fn()
      .mockRejectedValue(new Response("Unauthorized", { status: 401 }));
    const fetchImpl = vi.fn();
    await expect(
      forwardTranscription(request(), {
        queryUrl: "https://query.example",
        queryAudience: "query-audience",
        verifyBrowser,
        resolveCompanyId: vi.fn(),
        forwardingHeaders: vi.fn(),
        fetchImpl
      })
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a server-resolved company", async () => {
    const fetchImpl = vi.fn();
    await expect(
      forwardTranscription(request(), {
        queryUrl: "https://query.example",
        queryAudience: "query-audience",
        verifyBrowser: vi
          .fn()
          .mockResolvedValue({ token: { sub: "google-alice" } }),
        resolveCompanyId: vi.fn().mockResolvedValue(""),
        forwardingHeaders: vi.fn(),
        fetchImpl
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
