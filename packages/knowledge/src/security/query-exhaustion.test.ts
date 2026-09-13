import { describe, expect, it } from "vitest";
import { AuthorizedCache } from "../cache/cache.server";
import { queryRequestSchema } from "../contracts";
import { requestBoundary } from "../query/request-boundary.server";
import { checkRetrievalBounds } from "../retrieval/lexical.server";

const scope = {
  companyId: "cmp_alpha",
  actorId: "usr_alex",
  callerId: "portal",
  capability: "knowledge.read",
  intent: "locate",
  entities: ["source-alpha"],
  query: "MTR-100",
  locale: "en",
  businessTimezone: "UTC",
  modelVersion: "locate-no-model",
  promptVersion: "query-v1",
  indexVersion: "lexical-v1"
};
const policy = { allowed: true, policyVersion: "1", epochs: {} };

describe("query exhaustion against the request limits", () => {
  it("bounds retrieval fan-out, query length and result limits", () => {
    expect(() => checkRetrievalBounds("manual", ["a"], 40)).not.toThrow();
    expect(() => checkRetrievalBounds("x".repeat(8_001), ["a"], 10)).toThrow(
      "Invalid retrieval bounds"
    );
    expect(() =>
      checkRetrievalBounds("manual", ["a", "b", "c", "d", "e"], 10)
    ).toThrow("Invalid retrieval bounds");
    expect(() => checkRetrievalBounds("manual", ["a"], 41)).toThrow();
    expect(() => checkRetrievalBounds("manual", ["a"], 0)).toThrow();
    expect(() => checkRetrievalBounds("   ", ["a"], 10)).toThrow();
  });

  it("rejects an oversized query at the contract before any retrieval", () => {
    const base = { requestId: "r", mode: "locate", locale: "en" };
    expect(
      queryRequestSchema.safeParse({ ...base, text: "x".repeat(8_000) }).success
    ).toBe(true);
    expect(
      queryRequestSchema.safeParse({ ...base, text: "x".repeat(8_001) }).success
    ).toBe(false);
  });

  it("refuses the 129th concurrent distinct computation instead of queueing it", async () => {
    const gate = Promise.withResolvers<void>();
    const cache = new AuthorizedCache(
      { get: async () => undefined, set: async () => undefined },
      async () => policy
    );
    const read = (index: number) =>
      cache.get(
        { ...scope, query: `exhaustion-${index}` },
        async () => {
          await gate.promise;
          return { value: index, evidenceIds: [] };
        },
        Number,
        async () => true
      );
    const pending = Array.from({ length: 128 }, (_, index) => read(index));
    await expect(read(128)).rejects.toThrow("Query concurrency limit reached");
    gate.resolve();
    expect((await Promise.all(pending)).length).toBe(128);
    expect(await read(129)).toBe(129);
  });

  it("times out a handler that ignores cancellation and reports a request id", async () => {
    const records: unknown[] = [];
    const handler = requestBoundary(
      "query",
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new Error("slow dependency canceled"))
          );
        }),
      { milliseconds: 20, sink: (record) => void records.push(record) }
    );
    const response = await handler(
      new Request("https://query.example.test/v1/query")
    );
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "request_deadline_exceeded"
    });
    expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    expect(records.at(-1)).toMatchObject({
      stage: "request",
      outcome: "timeout"
    });
  });
});
