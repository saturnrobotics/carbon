import { createTelemetry } from "@carbon/portal/telemetry";
import { describe, expect, it } from "vitest";
import { createBacklogObserver } from "./backlog";

const principal = { companyId: "company-a", callerId: "indexer" };

describe("outbox backlog observation", () => {
  it("emits the backlog ages through the telemetry allowlist", async () => {
    const records: unknown[] = [];
    const observe = createBacklogObserver({
      telemetry: createTelemetry("worker", (record) => records.push(record)),
      backlog: async () => ({ pending: 2, lagSeconds: 930.25, queueSeconds: 0 })
    });
    await observe(principal);
    expect(records).toEqual([
      expect.objectContaining({
        service: "worker",
        stage: "indexing",
        outcome: "success",
        count: 2,
        lagSeconds: 930.25,
        queueSeconds: 0
      })
    ]);
    expect(JSON.stringify(records)).not.toContain("company-a");
  });

  it("reports a failed observation as an indexing error without interrupting delivery", async () => {
    const records: { stage: string; outcome: string }[] = [];
    const observe = createBacklogObserver({
      telemetry: createTelemetry("worker", (record) => records.push(record)),
      backlog: async () => {
        throw new Error("connection to 10.0.0.9 refused");
      }
    });
    await expect(observe(principal)).resolves.toBeUndefined();
    expect(records).toEqual([
      expect.objectContaining({ stage: "indexing", outcome: "error" })
    ]);
    expect(JSON.stringify(records)).not.toContain("10.0.0.9");
  });
});
