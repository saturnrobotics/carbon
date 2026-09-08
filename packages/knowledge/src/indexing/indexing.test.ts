import { describe, expect, it } from "vitest";
import { chunkBlocks, splitForEmbedding } from "./chunks";
import { confirmOutboxApplied, prioritizeOutbox } from "./outbox.server";

describe("chunkBlocks", () => {
  it("retains a table and its footnote under the heading", () => {
    const chunks = chunkBlocks(
      [
        { kind: "heading", text: "Torque", page: 2 },
        { kind: "table", text: "M4 | 3 Nm", page: 2 },
        { kind: "footnote", text: "dry thread", page: 2 }
      ],
      5
    );
    expect(chunks[0]).toMatchObject({ parentHeading: "Torque" });
    expect(chunks[0]?.text).toContain("dry thread");
  });

  it("delivers deletion and ACL invalidation ahead of content updates", () => {
    const common = {
      sourceId: "source",
      entityType: "document",
      sourceVersion: "1"
    };
    expect(
      prioritizeOutbox([
        { ...common, entityId: "upsert", eventType: "upsert" },
        { ...common, entityId: "delete", eventType: "delete" },
        { ...common, entityId: "acl", eventType: "acl-change" }
      ]).map((event) => event.entityId)
    ).toEqual(["delete", "acl", "upsert"]);
  });

  it("splits parser evidence below the provider byte ceiling without breaking Unicode", () => {
    const chunks = splitForEmbedding("🛠".repeat(2_100));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("🛠".repeat(2_100));
    expect(
      chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 8_000)
    ).toBe(true);
  });

  it("confirms every lexical chunk has the configured non-null embedding before acknowledgement", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: sql.includes("NOT EXISTS") ? [{ ready: 1 }] : [] };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client };
    await confirmOutboxApplied(
      pool as never,
      { companyId: "company", callerId: "worker" },
      {
        id: "event",
        sourceId: "source",
        entityType: "document",
        entityId: "document",
        sourceVersion: "7",
        eventType: "upsert",
        payload: {}
      },
      "embedding-v2"
    );
    const confirmation = calls.find((call) =>
      call.sql.includes("knowledge.chunk")
    );
    expect(confirmation?.sql).toContain("NOT EXISTS");
    expect(confirmation?.values).toContain("embedding-v2");
  });

  it("acknowledges manual-v1 after the lexical projection commits without an embedding", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return {
          rows: sql.includes("embeddingProfile\"='lexical-v1'")
            ? [{ ready: 1 }]
            : []
        };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client };
    await confirmOutboxApplied(
      pool as never,
      { companyId: "company", callerId: "worker" },
      {
        id: "event",
        sourceId: "source",
        entityType: "document",
        entityId: "document",
        sourceVersion: "7",
        eventType: "upsert",
        payload: {}
      },
      "manual-v1"
    );
    expect(calls.some((sql) => sql.includes("embedding IS NOT NULL"))).toBe(
      false
    );
  });
});
