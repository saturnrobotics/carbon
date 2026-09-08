import { createHash } from "node:crypto";
import { durableBudget } from "@carbon/knowledge/budgets.server";
import {
  type VerifiedWorkforceIdentity,
  verifyWorkforceRequest
} from "@carbon/knowledge/identity.server";
import { RoundingMode, round } from "@carbon/utils";
import type { Pool } from "pg";
import { z } from "zod";

export const MAX_TRANSCRIBE_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSCRIBE_SECONDS = 60;
const endpoint = "transcribe";
const acceptedAudioTypes = new Set(["audio/wav", "audio/x-wav"]);
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 8_000;

export const transcriptionConfigurationSchema = z
  .object({
    version: z.string().min(1).max(100),
    provider: z.literal("openai"),
    model: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,100}$/)
      .refine(
        (value) => !value.includes("latest") && !value.includes("preview")
      ),
    pricing: z
      .object({
        model: z.literal("per-second"),
        microUsdPerSecond: z.number().int().positive().max(10_000_000)
      })
      .strict(),
    maxTokens: z.number().int().positive().max(1_000_000),
    maxMicroUsd: z.number().int().positive().max(1_000_000_000)
  })
  .strict();
export type TranscriptionConfiguration = z.infer<
  typeof transcriptionConfigurationSchema
>;

type IdentityOptions = Omit<
  Parameters<typeof verifyWorkforceRequest>[0],
  "request" | "operation"
>;

type Budget = ReturnType<typeof durableBudget>;

function badRequest(message: string, status = 422): never {
  throw new Response(message, { status });
}

function requestId(request: Request) {
  const value = request.headers.get("x-request-id")?.trim();
  if (!value || value.length > 256 || /\s/.test(value)) {
    badRequest("A bounded request ID is required", 422);
  }
  return value;
}

function providerCost(
  durationSeconds: number,
  configuration: TranscriptionConfiguration
) {
  return round(
    durationSeconds * configuration.pricing.microUsdPerSecond,
    0,
    RoundingMode.Up
  );
}

/**
 * Parses only canonical RIFF PCM metadata in memory. Unlike general media
 * tools it follows no playlists, URLs, embedded paths, or external codecs.
 */
export async function probeWavDuration(file: File): Promise<number> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength < 44 || bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
    badRequest("Use a bounded PCM/WAV recording");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (
    ascii(0, 4) !== "RIFF" ||
    ascii(8, 4) !== "WAVE" ||
    view.getUint32(4, true) + 8 !== bytes.byteLength
  ) {
    badRequest("Use a canonical PCM/WAV recording");
  }
  let offset = 12;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const next = dataOffset + chunkSize + (chunkSize % 2);
    if (next > bytes.byteLength || next < dataOffset)
      badRequest("Invalid WAV chunk length");
    const kind = ascii(offset, 4);
    if (kind === "fmt ") {
      if (chunkSize < 16 || byteRate !== undefined)
        badRequest("Invalid PCM/WAV format");
      const format = view.getUint16(dataOffset, true);
      const channels = view.getUint16(dataOffset + 2, true);
      const sampleRate = view.getUint32(dataOffset + 4, true);
      byteRate = view.getUint32(dataOffset + 8, true);
      const blockAlign = view.getUint16(dataOffset + 12, true);
      const bitsPerSample = view.getUint16(dataOffset + 14, true);
      const expectedBlockAlign = channels * (bitsPerSample / 8);
      if (
        format !== 1 ||
        channels < 1 ||
        channels > 2 ||
        sampleRate < 8_000 ||
        sampleRate > 192_000 ||
        ![8, 16, 24, 32].includes(bitsPerSample) ||
        blockAlign !== expectedBlockAlign ||
        byteRate !== sampleRate * blockAlign
      )
        badRequest("Use uncompressed PCM/WAV audio");
    } else if (kind === "data") {
      if (dataBytes !== undefined) badRequest("Invalid PCM/WAV audio data");
      dataBytes = chunkSize;
    }
    offset = next;
  }
  if (
    offset !== bytes.byteLength ||
    !byteRate ||
    dataBytes === undefined ||
    dataBytes === 0
  ) {
    badRequest("The recording has no measurable audio duration");
  }
  const seconds = dataBytes / byteRate;
  if (!Number.isFinite(seconds) || seconds <= 0)
    badRequest("The recording has no measurable audio duration");
  return seconds;
}

async function parseAudio(request: Request) {
  const form = await request.formData();
  const value = form.get("audio");
  if (!(value instanceof File)) badRequest("An audio recording is required");
  if (!acceptedAudioTypes.has(value.type)) {
    badRequest("Use a PCM/WAV audio recording", 415);
  }
  if (value.size === 0) badRequest("The audio recording is empty");
  if (value.size > MAX_TRANSCRIBE_BYTES) {
    badRequest("The audio recording exceeds the 20 MB limit", 413);
  }
  return value;
}

export async function transcribeWithOpenAi(options: {
  file: File;
  configuration: TranscriptionConfiguration;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const body = new FormData();
  body.set("model", options.configuration.model);
  body.set("file", options.file, options.file.name || "voice-recording");
  const response = await (options.fetchImpl ?? fetch)(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}` },
      body,
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (!response.ok) throw new Error("Transcription provider unavailable");
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new Error("Transcription provider response exceeds the limit");
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("Transcription provider returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Transcription provider response exceeds the limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const payload = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    payload.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error("Transcription provider returned an invalid response");
  }
  if (
    !result ||
    typeof result !== "object" ||
    typeof (result as { text?: unknown }).text !== "string"
  ) {
    throw new Error("Transcription provider returned an invalid response");
  }
  const text = (result as { text: string }).text.trim();
  if (text.length > MAX_TRANSCRIPT_CHARACTERS) {
    throw new Error("Transcription provider returned an oversized transcript");
  }
  if (!text) badRequest("No speech was detected in the recording");
  return text;
}

export function createTranscriptionHandler(options: {
  workforce: IdentityOptions;
  pool: Pool;
  configuration: TranscriptionConfiguration;
  openAiApiKey: string;
  fetchImpl?: typeof fetch;
  probeDuration?: (file: File) => Promise<number>;
  createBudget?: (principal: VerifiedWorkforceIdentity["principal"]) => Budget;
}) {
  const configuration = transcriptionConfigurationSchema.parse(
    options.configuration
  );
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    try {
      const identity = await verifyWorkforceRequest({
        ...options.workforce,
        request,
        operation: "knowledge.transcribe"
      });
      if (!identity.principal.capabilities.includes("knowledge.transcribe")) {
        return new Response("Transcription is not authorized", { status: 403 });
      }
      const id = requestId(request);
      const file = await parseAudio(request);
      const durationSeconds = await (options.probeDuration ?? probeWavDuration)(
        file
      );
      if (
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        durationSeconds > MAX_TRANSCRIBE_SECONDS
      ) {
        return new Response("Recordings may be at most 60 seconds", {
          status: 422
        });
      }
      const payloadHash = createHash("sha256")
        .update(configuration.version)
        .update(configuration.provider)
        .update(configuration.model)
        .update(Buffer.from(await file.arrayBuffer()))
        .digest("hex");
      const maxMicroUsd = providerCost(MAX_TRANSCRIBE_SECONDS, configuration);
      if (maxMicroUsd > configuration.maxMicroUsd) {
        throw new Error(
          "Configured transcription ceiling is lower than the provider maximum"
        );
      }
      const budget = (
        options.createBudget ??
        ((principal) => durableBudget(options.pool, principal))
      )(identity.principal);
      await budget.reserve({
        endpoint,
        requestId: id,
        payloadHash,
        maxTokens: configuration.maxTokens,
        maxMicroUsd
      });
      const text = await transcribeWithOpenAi({
        file,
        configuration,
        apiKey: options.openAiApiKey,
        fetchImpl: options.fetchImpl
      });
      const actualMicroUsd = providerCost(durationSeconds, configuration);
      // This explicit per-second price profile has no token-priced dimension.
      await budget.settle(endpoint, id, 0, actualMicroUsd);
      return Response.json(
        { requestId: id, text },
        { headers: { "cache-control": "no-store" } }
      );
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Transcription is unavailable", { status: 503 });
    }
  };
}

export function transcriptionConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): TranscriptionConfiguration | undefined {
  const raw = environment.KNOWLEDGE_STT_CONFIGURATION_JSON;
  if (!raw) return undefined;
  return transcriptionConfigurationSchema.parse(JSON.parse(raw));
}
