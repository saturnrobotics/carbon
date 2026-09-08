import { randomUUID } from "node:crypto";

const stages = [
  "request",
  "authentication",
  "policy",
  "cache",
  "router",
  "retrieval",
  "source",
  "model",
  "embedding",
  "indexing",
  "retention"
] as const;
const outcomes = [
  "allow",
  "deny",
  "success",
  "error",
  "hit",
  "miss",
  "partial",
  "timeout"
] as const;
type Stage = (typeof stages)[number];
type Outcome = (typeof outcomes)[number];
type Metrics = {
  durationMs?: number;
  count?: number;
  tokens?: number;
  microUsd?: number;
  status?: number;
};
export type TelemetryRecord = Metrics & {
  schemaVersion: 1;
  service: "query" | "actions" | "worker";
  requestId: string;
  stage: Stage;
  outcome: Outcome;
};
export type Telemetry = ReturnType<typeof createTelemetry>;

/** A positive allowlist, not key-name redaction. Never accept arbitrary metadata/errors. */
export function createTelemetry(
  service: TelemetryRecord["service"],
  sink: (record: TelemetryRecord) => void = (record) =>
    process.stdout.write(`${JSON.stringify(record)}\n`)
) {
  const id = randomUUID();
  function record(stage: Stage, outcome: Outcome, metrics: Metrics = {}) {
    if (
      !stages.includes(stage) ||
      !outcomes.includes(outcome) ||
      !["query", "actions", "worker"].includes(service)
    )
      throw Error("Invalid telemetry event");
    const event: TelemetryRecord = {
      schemaVersion: 1,
      service,
      requestId: id,
      stage,
      outcome
    };
    for (const key of [
      "durationMs",
      "count",
      "tokens",
      "microUsd",
      "status"
    ] as const) {
      const value = metrics[key];
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 1e12
      )
        event[key] = Math.round(value * 1000) / 1000;
    }
    try {
      sink(event);
    } catch {
      /* Logging cannot change an authorization decision. */
    }
  }
  async function measure<T>(
    stage: Stage,
    operation: () => Promise<T>
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await operation();
      record(stage, "success", { durationMs: performance.now() - start });
      return result;
    } catch (error) {
      record(stage, "error", { durationMs: performance.now() - start });
      throw error;
    }
  }
  return { id, record, measure };
}
