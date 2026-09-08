import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionHandler,
  probeWavDuration,
  type TranscriptionConfiguration
} from "./transcribe.server";

const configuration: TranscriptionConfiguration = {
  version: "stt.v1",
  provider: "openai",
  model: "gpt-4o-mini-transcribe-2025-12-15",
  pricing: { model: "per-second", microUsdPerSecond: 10 },
  maxTokens: 100,
  maxMicroUsd: 600
};

const workforce = {
  configuration: {
    version: 1 as const,
    receiver: { id: "query", audience: "query-aud" },
    callers: [
      {
        callerId: "web",
        serviceAccountSubject: "sa-web",
        sourceIapAudience: "iap-web",
        operations: ["knowledge.transcribe"],
        capabilities: ["knowledge.transcribe"],
        requiredAccessLevels: []
      }
    ]
  },
  tokenVerifier: {
    verifyServiceToken: async () => ({
      iss: "https://accounts.google.com",
      sub: "sa-web",
      aud: "query-aud",
      iat: 900,
      exp: 1200
    }),
    verifyIapToken: async () => ({
      iss: "https://cloud.google.com/iap",
      sub: "google-alice",
      aud: "iap-web",
      iat: 900,
      exp: 1200
    })
  },
  nowEpochSeconds: 1000,
  identityStore: {
    resolveHuman: async () => ({
      actorId: "alice",
      companyId: "company-a",
      companyGroupId: "group-a",
      bindingActive: true,
      userActive: true,
      membershipActive: true,
      revocationVersion: 1,
      permissionsVersion: "1",
      capabilities: ["knowledge.transcribe"]
    })
  }
};

function wav(seconds: number) {
  const sampleRate = 8000;
  const bytes = new Uint8Array(44 + seconds * sampleRate * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, bytes.length - 44, true);
  return new File([bytes], "command.wav", { type: "audio/wav" });
}

function request(file = wav(1), id = "transcribe-1") {
  const body = new FormData();
  body.set("audio", file);
  return new Request("https://query.example/v1/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer service",
      "x-portal-user-evidence": "iap",
      "x-portal-company-id": "company-a",
      "x-request-id": id
    },
    body
  });
}

describe("query transcription", () => {
  it("parses bounded PCM/WAV duration in memory without an external media tool", async () => {
    await expect(probeWavDuration(wav(1))).resolves.toBeCloseTo(1, 2);
  });

  it("rejects malformed WAV metadata before budget reservation or provider access", async () => {
    const invalid = new File(["not a wave file"], "invalid.wav", {
      type: "audio/wav"
    });
    await expect(probeWavDuration(invalid)).rejects.toMatchObject({
      status: 422
    });
    const reserve = vi.fn();
    const handler = createTranscriptionHandler({
      workforce,
      pool: {} as never,
      configuration,
      openAiApiKey: "test-key",
      createBudget: vi.fn().mockReturnValue({ reserve, settle: vi.fn() }),
      fetchImpl: vi.fn()
    });
    expect((await handler(request(invalid))).status).toBe(422);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("verifies identity and audio duration before reserving and calling the provider", async () => {
    const reserve = vi.fn().mockResolvedValue(undefined);
    const settle = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "Create a ticket" }), {
        status: 200
      })
    );
    const handler = createTranscriptionHandler({
      workforce,
      pool: {} as never,
      configuration,
      openAiApiKey: "test-key",
      probeDuration: vi.fn().mockResolvedValue(2),
      createBudget: vi.fn().mockReturnValue({ reserve, settle }),
      fetchImpl
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId: "transcribe-1",
      text: "Create a ticket"
    });
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "transcribe",
        maxTokens: 100,
        maxMicroUsd: 600
      })
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith("transcribe", "transcribe-1", 0, 20);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[0]!
    );
  });

  it("does not reserve or call the provider when parsed duration exceeds the policy", async () => {
    const reserve = vi.fn();
    const fetchImpl = vi.fn();
    const handler = createTranscriptionHandler({
      workforce,
      pool: {} as never,
      configuration,
      openAiApiKey: "test-key",
      createBudget: vi.fn().mockReturnValue({ reserve, settle: vi.fn() }),
      fetchImpl
    });

    expect((await handler(request(wav(61)))).status).toBe(422);
    expect(reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not make a second provider call when durable reservation rejects a retry", async () => {
    const fetchImpl = vi.fn();
    const handler = createTranscriptionHandler({
      workforce,
      pool: {} as never,
      configuration,
      openAiApiKey: "test-key",
      probeDuration: vi.fn().mockResolvedValue(1),
      createBudget: vi.fn().mockReturnValue({
        reserve: vi.fn().mockRejectedValue(new Error("already reserved")),
        settle: vi.fn()
      }),
      fetchImpl
    });

    expect((await handler(request())).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
