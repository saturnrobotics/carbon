import type { LeasedOutboxEvent } from "@carbon/portal/indexing/outbox.server";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { applyOutboxInvalidation } from "./invalidation";

/**
 * A recording pool: every statement the batch issues is captured in order so
 * the test can assert sequencing (epochs before confirmation before ack) and
 * isolation (one failed confirmation defers one event). Real row policies and
 * real Redis are covered by packages/portal cache/revocation.integration.
 */
function recordingPool(options: { tombstoned: ReadonlySet<string> }) {
  const statements: string[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      statements.push(text.replace(/\s+/g, " ").trim());
      if (text.includes("UPDATE portal.source"))
        return {
          rows: (values?.[1] as string[]).map((sourceId) => ({
            sourceId,
            contentEpoch: "2",
            aclEpoch: "2"
          })),
          rowCount: (values?.[1] as string[]).length
        };
      if (text.includes("SELECT 1 FROM portal.document"))
        return {
          rows: options.tombstoned.has(values?.[1] as string) ? [1] : [],
          rowCount: 0
        };
      if (text.includes('SET "deliveredAt"=now()'))
        return { rows: [], rowCount: (values?.[2] as string[]).length };
      return { rows: [], rowCount: 0 };
    },
    release() {
      /* Nothing to return to a recording pool. */
    }
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, statements };
}

const principal = {
  companyId: "company-a",
  callerId: "indexer-a",
  sourceId: "source-a"
};
function event(
  id: string,
  eventType: LeasedOutboxEvent["eventType"],
  entityId = "doc-a",
  entityType = "document"
): LeasedOutboxEvent {
  return {
    id,
    sourceId: "source-a",
    entityType,
    entityId,
    sourceVersion: `v-${id}`,
    eventType,
    payload: {}
  };
}

describe("outbox invalidation batch", () => {
  it("advances epochs before confirming or acknowledging any event", async () => {
    const { pool, statements } = recordingPool({
      tombstoned: new Set(["doc-a"])
    });
    const result = await applyOutboxInvalidation(pool, principal, "worker-1", [
      event("e1", "board-change", "board-7", "board"),
      event("e2", "delete"),
      event("e3", "acl-change"),
      event("e4", "index-version", "generation-3", "index")
    ]);
    expect(result.plan).toEqual([
      { sourceId: "source-a", acl: true, content: true }
    ]);
    expect(result.acknowledged).toEqual(["e1", "e2", "e3", "e4"]);
    expect(result.deferred).toEqual([]);
    const bump = statements.findIndex((s) =>
      s.includes("UPDATE portal.source")
    );
    const firstAck = statements.findIndex((s) =>
      s.includes('SET "deliveredAt"=now()')
    );
    const firstConfirm = statements.findIndex((s) =>
      s.includes("SELECT 1 FROM portal.document")
    );
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThan(Math.min(firstConfirm, firstAck));
    // A confirmable event is confirmed before its own acknowledgement.
    const tombstoneConfirm = statements.findIndex(
      (s, index) =>
        index > firstAck && s.includes("SELECT 1 FROM portal.document")
    );
    const tombstoneAck = statements.findIndex(
      (s, index) =>
        index > tombstoneConfirm && s.includes('SET "deliveredAt"=now()')
    );
    expect(tombstoneConfirm).toBeGreaterThan(firstAck);
    expect(tombstoneAck).toBeGreaterThan(tombstoneConfirm);
    // Only the local document kinds are confirmed; external kinds ack directly.
    expect(
      statements.filter((s) => s.includes("SELECT 1 FROM portal.document"))
    ).toHaveLength(2);
  });
  it("defers an unconfirmed tombstone without blocking the rest of the batch", async () => {
    const { pool, statements } = recordingPool({ tombstoned: new Set() });
    const result = await applyOutboxInvalidation(pool, principal, "worker-1", [
      event("e1", "delete"),
      event("e2", "correction", "doc-a", "document"),
      event("e3", "acl-change", "doc-b")
    ]);
    expect(result.acknowledged).toEqual(["e2"]);
    expect(result.deferred).toEqual(["e1", "e3"]);
    // The revocation still reached the epochs even though its ack is deferred.
    expect(statements.some((s) => s.includes("UPDATE portal.source"))).toBe(
      true
    );
    expect(
      statements.filter((s) => s.includes('SET "deliveredAt"=now()'))
    ).toHaveLength(1);
  });
  it("does nothing for an empty batch", async () => {
    const { pool, statements } = recordingPool({ tombstoned: new Set() });
    expect(
      await applyOutboxInvalidation(pool, principal, "worker-1", [])
    ).toEqual({ plan: [], acknowledged: [], deferred: [] });
    expect(statements).toEqual([]);
  });
});
