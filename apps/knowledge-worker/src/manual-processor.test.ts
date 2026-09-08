import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { processKnowledgeOutbox } from "./processor";

const event = {
  id: "event",
  sourceId: "manuals",
  entityType: "document",
  entityId: "document",
  sourceVersion: "1",
  eventType: "upsert" as const,
  payload: {}
};
const principal = {
  companyId: "company",
  callerId: "worker",
  sourceId: "manuals"
};
function runtime(inputRefs: unknown = []) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM knowledge.source")
      ? [{}]
      : sql.includes("FROM knowledge.intake")
        ? [{ state: "captured", inputRefs, generation: "1", version: "1" }]
        : []
  }));
  const connect = vi.fn(async () => ({ query, release: vi.fn() }));
  const external = vi.fn(async () => {
    throw Error("External provider must not be invoked");
  });
  return {
    pool: { connect } as unknown as Pool,
    bucket: "synthetic",
    automationUserId: "automation",
    manualSourceId: "manuals",
    parseDocument: external,
    loadDriveDocument: external,
    embedding: { profile: "deferred", embedBatch: external },
    connect,
    external
  };
}

describe("manual outbox capability boundary", () => {
  it("never calls Drive or embeddings for manually published document events", async () => {
    const dependencies = runtime();
    await processKnowledgeOutbox(dependencies, principal, event);
    expect(dependencies.external).not.toHaveBeenCalled();
  });
  it("rejects other sources before database or provider access", async () => {
    const dependencies = runtime();
    await expect(
      processKnowledgeOutbox(dependencies, principal, {
        ...event,
        sourceId: "drive"
      })
    ).rejects.toThrow("Manual source unavailable");
    expect(dependencies.connect).not.toHaveBeenCalled();
  });
  it("cannot turn a legacy URL intake into an outbound fetch", async () => {
    const dependencies = runtime([
      { kind: "url", url: "https://example.com/manual.pdf" }
    ]);
    await expect(
      processKnowledgeOutbox(dependencies, principal, {
        ...event,
        entityType: "intake"
      })
    ).rejects.toThrow("immutable uploaded object");
    expect(dependencies.external).not.toHaveBeenCalled();
  });
});
