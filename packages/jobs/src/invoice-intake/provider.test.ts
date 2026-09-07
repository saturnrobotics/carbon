import { describe, expect, it, vi } from "vitest";
import {
  emptyInvoiceExtraction,
  invoiceExtractionEnvelopeSchema
} from "./contracts";
import {
  createGoogleInvoiceProvider,
  googleResponseSchema,
  InvoiceProviderError,
  invoiceUsageCost,
  loadInvoiceProviderConfig
} from "./provider";

const env = {
  INVOICE_INTAKE_ENABLED: "true",
  INVOICE_AI_PROJECT: "example-project",
  INVOICE_AI_PRICE_VERIFIED_AT: "2026-09-06",
  INVOICE_AI_INPUT_PRICE_USD_PER_MILLION: "1.65",
  INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION: "9.9"
};
const document = {
  bytes: new TextEncoder().encode("%PDF-1.4 synthetic"),
  mimeType: "application/pdf" as const
};
const token = () =>
  Response.json({
    access_token: "test-token",
    token_type: "Bearer",
    expires_in: 3600
  });
const completion = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify(emptyInvoiceExtraction()) }] }
      }
    ],
    usageMetadata: {
      promptTokenCount: 3000,
      candidatesTokenCount: 1000,
      thoughtsTokenCount: 200,
      totalTokenCount: 4200
    },
    modelVersion: "gemini-3.5-flash",
    ...overrides
  });

describe("invoice inference configuration", () => {
  it("defaults off and never uses a global endpoint", () => {
    expect(loadInvoiceProviderConfig({}).enabled).toBe(false);
    for (const change of [
      { INVOICE_AI_LOCATION: "global" },
      { INVOICE_AI_PROJECT: "example/../../other" },
      { INVOICE_AI_MODEL: "https://example.com" },
      { INVOICE_AI_MAX_OUTPUT_TOKENS: "Infinity" },
      { INVOICE_AI_INPUT_PRICE_USD_PER_MILLION: "0" },
      { INVOICE_AI_PRICE_VERIFIED_AT: "" },
      { INVOICE_AI_PRICE_VERIFIED_AT: "2026-02-30" }
    ])
      expect(() => loadInvoiceProviderConfig({ ...env, ...change })).toThrow(
        "inference_configuration_invalid"
      );
  });
  it("includes thought tokens in charge", () => {
    expect(
      invoiceUsageCost(loadInvoiceProviderConfig(env), {
        inputTokens: 5000,
        outputTokens: 1000,
        thoughtTokens: 1000,
        totalTokens: 7000
      })
    ).toBeCloseTo(0.02805);
  });
  it("converts the actual shared schema including nullable fields", () => {
    const json = googleResponseSchema(invoiceExtractionEnvelopeSchema);
    expect(json.type).toBe("OBJECT");
    const encoded = JSON.stringify(json);
    expect(encoded).not.toContain("additionalProperties");
    expect(encoded).not.toContain("$schema");
    expect(encoded).toContain('"nullable":true');
    expect(encoded).toContain(
      '"schemaVersion":{"type":"STRING","enum":["invoice-intake.v1"]}'
    );
  });
});

describe("Google invoice REST boundary", () => {
  it("sends private bytes and validated schema to the explicit US endpoint", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ totalTokens: 4000 }))
      .mockResolvedValueOnce(completion());
    const provider = createGoogleInvoiceProvider(
      loadInvoiceProviderConfig(env),
      { fetch: request }
    );
    const prepared = provider.prepareExtraction(document);
    const estimate = await provider.estimate(prepared);
    expect(estimate.reservedInputTokens).toBe(8000);
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://aiplatform.us.rep.googleapis.com/v1/projects/example-project/locations/us/publishers/google/models/gemini-3.5-flash:countTokens"
    );
    // Vertex v1 takes the contents and complete generation config at the top
    // level. A generateContentRequest wrapper is rejected before admission.
    const countBody = JSON.parse(request.mock.calls[1]?.[1]?.body as string);
    expect(countBody).toEqual({
      ...prepared.body,
      model:
        "projects/example-project/locations/us/publishers/google/models/gemini-3.5-flash"
    });
    expect(countBody.generateContentRequest).toBeUndefined();
    const result = await provider.execute(prepared);
    expect(result.result).toEqual(emptyInvoiceExtraction());
    expect(result.usage.thoughtTokens).toBe(200);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({
      "Metadata-Flavor": "Google"
    });
    expect(request.mock.calls[2]?.[0]).toBe(
      "https://aiplatform.us.rep.googleapis.com/v1/projects/example-project/locations/us/publishers/google/models/gemini-3.5-flash:generateContent"
    );
    const body = JSON.parse(request.mock.calls[2]?.[1]?.body as string);
    expect(body.contents[0].parts[1].inlineData).toEqual({
      mimeType: "application/pdf",
      data: Buffer.from(document.bytes).toString("base64")
    });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.tools).toBeUndefined();
    expect(request.mock.calls[2]?.[1]?.redirect).toBe("error");
  });

  it("refreshes temporary tokens early without retrying paid requests internally", async () => {
    let monotonic = 0;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(completion())
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(completion());
    const provider = createGoogleInvoiceProvider(
      loadInvoiceProviderConfig(env),
      { fetch: request, now: () => monotonic }
    );
    const prepared = provider.prepareExtraction(document);
    await provider.execute(prepared);
    monotonic = 3550000;
    await provider.execute(prepared);
    expect(
      request.mock.calls.filter(([url]) =>
        String(url).includes("metadata.google.internal")
      )
    ).toHaveLength(2);
  });

  it("fails before a paid request when estimated input exceeds the reserved bound", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ totalTokens: 20000 }));
    const provider = createGoogleInvoiceProvider(
      loadInvoiceProviderConfig(env),
      { fetch: request }
    );
    await expect(
      provider.estimate(provider.prepareExtraction(document))
    ).rejects.toThrow("inference_input_token_limit");
    expect(
      request.mock.calls.some(([url]) =>
        String(url).endsWith(":generateContent")
      )
    ).toBe(false);
  });

  it.each([
    401, 429, 500, 503
  ])("makes exactly one paid attempt for HTTP %s and redacts response", async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        new Response("private invoice contents", { status })
      );
    const provider = createGoogleInvoiceProvider(
      loadInvoiceProviderConfig(env),
      { fetch: request }
    );
    await expect(
      provider.execute(provider.prepareExtraction(document))
    ).rejects.toMatchObject({
      code: "inference_http_error",
      status,
      retryable: true
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves charge evidence for malformed or truncated model output", async () => {
    for (const candidate of [
      { finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } },
      {
        finishReason: "STOP",
        content: { parts: [{ text: '{"private":"untrusted"}' }] }
      }
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(token())
        .mockResolvedValueOnce(completion({ candidates: [candidate] }));
      const provider = createGoogleInvoiceProvider(
        loadInvoiceProviderConfig(env),
        { fetch: request }
      );
      try {
        await provider.execute(provider.prepareExtraction(document));
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(InvoiceProviderError);
        expect((error as InvoiceProviderError).usage?.inputTokens).toBe(3000);
        expect(String(error)).not.toContain("private");
      }
    }
  });

  it("makes no requests when disabled or oversized", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = createGoogleInvoiceProvider(
      loadInvoiceProviderConfig({}),
      { fetch: request }
    );
    await expect(
      provider.execute(provider.prepareExtraction(document))
    ).rejects.toThrow("inference_disabled");
    expect(() =>
      provider.prepareExtraction({
        ...document,
        bytes: new Uint8Array(10 * 1024 * 1024 + 1)
      })
    ).toThrow("inference_document_size_invalid");
    expect(request).not.toHaveBeenCalled();
  });
});
