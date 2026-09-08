import { describe, expect, it } from "vitest";
import { createTelemetry } from "./telemetry";

describe("content-free service telemetry", () => {
  it("accepts only finite bounded metrics and a closed event vocabulary", () => {
    const records: unknown[] = [];
    const trace = createTelemetry("query", (record) => records.push(record));
    trace.record("authentication", "allow", {
      durationMs: 12,
      count: 1,
      prompt: "secret document",
      authorization: "Bearer private",
      actorId: "person@example.com"
    } as never);
    trace.record("retrieval", "error", {
      durationMs: Number.NaN,
      count: Number.POSITIVE_INFINITY
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toMatch(/secret|private|person@|NaN|Infinity/);
    expect(records).toMatchObject([
      { stage: "authentication", outcome: "allow", durationMs: 12, count: 1 },
      { stage: "retrieval", outcome: "error" }
    ]);
    expect(() => trace.record("raw prompt" as never, "allow")).toThrow();
  });
  it("uses an internally generated correlation ID and contains failed sinks", async () => {
    const trace = createTelemetry("query", () => {
      throw Error("logging unavailable");
    });
    expect(trace.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await trace.measure("policy", async () => 42)).toBe(42);
    await expect(
      trace.measure("model", async () => {
        throw Error("sensitive upstream message");
      })
    ).rejects.toThrow("sensitive upstream message");
  });
});
