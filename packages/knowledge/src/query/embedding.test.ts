import { describe, expect, it } from "vitest";
import { createVertexEmbedder } from "./embedding.server";

const config = {
  version: "synthetic-768-v1",
  project: "synthetic-project",
  location: "us-central1",
  model: "gemini-embedding-001",
  microUsdPerMillionTokens: 100000
};
describe("bounded managed embeddings", () => {
  it("reserves before disclosure and enforces an exact 768-dimensional result", async () => {
    const calls: string[] = [];
    const embed = createVertexEmbedder(config, {
      budget: {
        reserve: async () => {
          calls.push("reserve");
        },
        settle: async () => {
          calls.push("settle");
        }
      },
      accessToken: async () => "synthetic",
      fetch: async () => {
        calls.push("provider");
        return Response.json({
          predictions: [
            {
              embeddings: {
                values: [1, ...Array(767).fill(0)],
                statistics: { token_count: 12, truncated: false }
              }
            }
          ]
        });
      }
    });
    const result = await embed({
      text: "synthetic manual",
      requestId: "r1",
      task: "RETRIEVAL_QUERY",
      signal: new AbortController().signal
    });
    expect(result.embedding).toHaveLength(768);
    expect(calls).toEqual(["reserve", "provider", "settle"]);
  });
  it("rejects truncation rather than silently indexing incomplete content", async () => {
    const embed = createVertexEmbedder(config, {
      budget: { reserve: async () => {}, settle: async () => {} },
      accessToken: async () => "synthetic",
      fetch: async () =>
        Response.json({
          predictions: [
            {
              embeddings: {
                values: [1, ...Array(767).fill(0)],
                statistics: { token_count: 2000, truncated: true }
              }
            }
          ]
        })
    });
    await expect(
      embed({
        text: "manual",
        requestId: "r2",
        task: "RETRIEVAL_DOCUMENT",
        signal: new AbortController().signal
      })
    ).rejects.toThrow("truncated");
  });
});
