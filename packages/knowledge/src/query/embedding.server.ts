import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import type { BudgetReservation } from "../budgets.server";
import { validateEmbedding } from "../schema-contract";
import {
  boundedProviderJson,
  vertexConfigurationSchema
} from "./vertex.server";
export const embeddingConfigurationSchema = vertexConfigurationSchema
  .pick({ version: true, project: true, location: true, model: true })
  .extend({
    microUsdPerMillionTokens: z.number().int().positive().max(1000000000)
  })
  .strict();
export type EmbeddingConfiguration = z.infer<
  typeof embeddingConfigurationSchema
>;
type Dependencies = {
  budget: {
    reserve: (reservation: BudgetReservation) => Promise<void>;
    settle: (
      endpoint: string,
      requestId: string,
      tokens: number,
      microUsd: number
    ) => Promise<void>;
  };
  accessToken?: () => Promise<string>;
  fetch?: typeof fetch;
};
export function createVertexEmbedder(
  configuration: EmbeddingConfiguration,
  dependencies: Dependencies
) {
  const config = embeddingConfigurationSchema.parse(configuration);
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });
  const cost = (tokens: number) =>
    Number(
      (BigInt(tokens) * BigInt(config.microUsdPerMillionTokens) + 999999n) /
        1000000n
    );
  return async (input: {
    text: string;
    requestId: string;
    task: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
    signal: AbortSignal;
  }) => {
    if (
      !input.text.trim() ||
      new TextEncoder().encode(input.text).length > 8192
    )
      throw Error("Embedding input budget exceeded");
    const endpoint =
      input.task === "RETRIEVAL_DOCUMENT"
        ? "embedding-index"
        : "embedding-query";
    const payload = {
      instances: [{ content: input.text, task_type: input.task }],
      parameters: { outputDimensionality: 768, autoTruncate: false }
    };
    await dependencies.budget.reserve({
      endpoint,
      requestId: input.requestId,
      payloadHash: createHash("sha256")
        .update(JSON.stringify({ version: config.version, ...payload }))
        .digest("hex"),
      maxTokens: 2048,
      maxMicroUsd: Math.max(1, cost(2048))
    });
    const token = await (
      dependencies.accessToken ??
      (async () => {
        const value = await auth.getAccessToken();
        if (!value) throw Error("Embedding provider identity unavailable");
        return value;
      })
    )();
    const response = await (dependencies.fetch ?? fetch)(
      `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.project}/locations/${config.location}/publishers/google/models/${config.model}:predict`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(2000)])
      }
    );
    const schema = z.object({
      predictions: z
        .array(
          z.object({
            embeddings: z.object({
              values: z.array(z.number().finite()).length(768),
              statistics: z.object({
                token_count: z.number().int().nonnegative().max(2048),
                truncated: z.boolean()
              })
            })
          })
        )
        .length(1)
    });
    const parsed = schema.parse(await boundedProviderJson(response));
    const result = parsed.predictions[0]!.embeddings;
    if (result.statistics.truncated)
      throw Error("Embedding input was truncated");
    validateEmbedding(result.values);
    const norm = Math.sqrt(
      result.values.reduce((sum, value) => sum + value * value, 0)
    );
    if (!Number.isFinite(norm) || norm === 0)
      throw Error("Invalid zero embedding");
    await dependencies.budget.settle(
      endpoint,
      input.requestId,
      result.statistics.token_count,
      cost(result.statistics.token_count)
    );
    return {
      embedding: result.values.map((value) => value / norm),
      tokenCount: result.statistics.token_count,
      profile: config.version
    };
  };
}
