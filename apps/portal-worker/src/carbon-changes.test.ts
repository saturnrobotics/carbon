import type { CarbonChangeFeed } from "@carbon/portal/sources/carbon.server";
import type { SourceChange } from "@carbon/portal/sources/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  persist: vi.fn(),
  reconcile: vi.fn(),
  sweepState: vi.fn()
}));
vi.mock("@carbon/portal/sources/carbon.server", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@carbon/portal/sources/carbon.server")
    >();
  return {
    ...actual,
    persistCarbonChangePage: mocks.persist,
    reconcileCarbonRange: mocks.reconcile,
    getCarbonSweepState: mocks.sweepState
  };
});

import {
  pullCarbonChanges,
  readCarbonSourceConfiguration,
  sweepCarbonEntities
} from "./carbon-changes";

const company = { companyId: "company-a", callerId: "indexer-a" };
const entity = {
  id: "item-1",
  type: "part" as const,
  title: "Motor",
  revision: "2026-09-01T10:00:00.000000Z",
  fields: { readableId: "MTR-1", mpn: "M-1", revision: "B" }
};
const change = (id: string, withEntity = true): SourceChange => ({
  id,
  entityType: "item",
  entityId: "item-1",
  sourceVersion: "2026-09-01T10:00:00.000000Z",
  eventType: withEntity ? "upsert" : "delete",
  observedAt: "2026-09-01T10:00:05Z",
  entity: withEntity ? entity : null
});
const page = (items: SourceChange[], status: "complete" | "unavailable") => ({
  items,
  observedAt: "2026-09-01T10:00:05Z",
  sourceRevision: "carbon:test",
  status,
  ...(status === "unavailable" ? { incompleteReason: "outage" } : {})
});

function runtime(feed: Partial<CarbonChangeFeed>) {
  return {
    pool: {} as never,
    companies: [company],
    workerId: "worker-1",
    source: {
      sourceId: "source-carbon",
      origin: "https://erp.example",
      audience: "https://erp.example"
    },
    automationUserId: "automation",
    feed: () => feed as CarbonChangeFeed
  };
}

beforeEach(() => {
  mocks.persist.mockReset();
  mocks.reconcile.mockReset();
  mocks.sweepState.mockReset();
  mocks.persist.mockResolvedValue({
    upserted: 1,
    tombstoned: 0,
    invalidations: 0
  });
});

describe("Carbon change consumer", () => {
  it("acknowledges only after the projection committed, and reports a lost lease", async () => {
    const order: string[] = [];
    mocks.persist.mockImplementation(async () => {
      order.push("persist");
      return { upserted: 1, tombstoned: 0, invalidations: 0 };
    });
    const acknowledge = vi.fn(async (ids: readonly string[]) => {
      order.push("acknowledge");
      return ids.filter((id) => id !== "kso-lost");
    });
    const result = await pullCarbonChanges(
      runtime({
        getChanges: async () =>
          page([change("kso-1"), change("kso-lost", false)], "complete"),
        acknowledge
      }),
      company
    );
    expect(order).toEqual(["persist", "acknowledge"]);
    expect(acknowledge).toHaveBeenCalledWith(["kso-1", "kso-lost"]);
    expect(result).toMatchObject({
      claimed: 2,
      acknowledged: 1,
      unacknowledged: ["kso-lost"],
      status: "complete"
    });
    const [, principal, input] = mocks.persist.mock.calls[0] as [
      unknown,
      {
        companyId: string;
        callerId: string;
        sourceId: string;
        actorId?: string;
      },
      { plan: { upserts: unknown[]; tombstones: unknown[] } }
    ];
    expect(principal).toEqual({
      companyId: "company-a",
      callerId: "indexer-a",
      sourceId: "source-carbon"
    });
    expect(input.plan.upserts).toHaveLength(1);
    expect(input.plan.tombstones).toHaveLength(0);
  });
  it("neither writes nor acknowledges when the feed is unavailable or a commit fails", async () => {
    const acknowledge = vi.fn(async () => []);
    const unavailable = await pullCarbonChanges(
      runtime({
        getChanges: async () => page([change("kso-1")], "unavailable"),
        acknowledge
      }),
      company
    );
    expect(unavailable).toMatchObject({
      status: "unavailable",
      acknowledged: 0,
      unacknowledged: ["kso-1"]
    });
    expect(mocks.persist).not.toHaveBeenCalled();
    mocks.persist.mockRejectedValueOnce(new Error("commit failed"));
    await expect(
      pullCarbonChanges(
        runtime({
          getChanges: async () => page([change("kso-1")], "complete"),
          acknowledge
        }),
        company
      )
    ).rejects.toThrow("commit failed");
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it("sweeps one keyset page: refreshes stale projections and tombstones vanished ones", async () => {
    mocks.sweepState.mockResolvedValue({ entityType: "item", afterId: null });
    mocks.reconcile.mockResolvedValue({
      stale: ["item-1", "item-gone"],
      tombstoned: 1
    });
    const getProjections = vi.fn(async () => ({
      items: [entity],
      observedAt: "2026-09-01T10:00:09Z",
      sourceRevision: "carbon:test",
      status: "complete" as const
    }));
    const result = await sweepCarbonEntities(
      runtime({
        listVersions: async () => ({
          items: [
            { entityId: "item-1", sourceVersion: "new" },
            { entityId: "item-9", sourceVersion: "same" }
          ],
          nextCursor: "item-9",
          observedAt: "2026-09-01T10:00:08Z",
          sourceRevision: "carbon:test",
          status: "partial" as const,
          incompleteReason: "more-rows-behind-cursor"
        }),
        getProjections
      }),
      company
    );
    const reconcileInput = mocks.reconcile.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(reconcileInput).toMatchObject({
      entityType: "item",
      portalEntityType: "part",
      afterId: null,
      lastId: "item-9",
      expected: { entityType: "item", afterId: null },
      next: { entityType: "item", afterId: "item-9" }
    });
    expect(getProjections).toHaveBeenCalledWith({
      entityType: "item",
      entityIds: ["item-1", "item-gone"]
    });
    const plan = (
      mocks.persist.mock.calls[0]?.[2] as {
        plan: {
          upserts: unknown[];
          tombstones: Array<{ sourceEntityId: string; entityType: string }>;
        };
      }
    ).plan;
    expect(plan.upserts).toHaveLength(1);
    expect(plan.tombstones).toEqual([
      expect.objectContaining({
        sourceEntityId: "item-gone",
        entityType: "part"
      })
    ]);
    expect(result).toMatchObject({
      entityType: "item",
      listed: 2,
      tombstoned: 1,
      done: false
    });
  });
  it("closes the last page over an open range and moves to the next entity type", async () => {
    mocks.sweepState.mockResolvedValue({
      entityType: "item",
      afterId: "item-9"
    });
    mocks.reconcile.mockResolvedValue({ stale: [], tombstoned: 0 });
    const result = await sweepCarbonEntities(
      runtime({
        listVersions: async () => ({
          items: [],
          observedAt: "2026-09-01T10:00:08Z",
          sourceRevision: "carbon:test",
          status: "complete" as const
        }),
        getProjections: vi.fn()
      }),
      company
    );
    expect(mocks.reconcile.mock.calls[0]?.[2]).toMatchObject({
      afterId: "item-9",
      lastId: null,
      next: { entityType: "receipt", afterId: null }
    });
    expect(result.done).toBe(true);
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("registers only when the Carbon source is configured", () => {
    expect(readCarbonSourceConfiguration({})).toBeNull();
    expect(
      readCarbonSourceConfiguration({
        PORTAL_CARBON_SOURCE_JSON:
          '{"sourceId":"source-carbon","origin":"https://erp.example","audience":"https://erp.example"}'
      })
    ).toEqual({
      sourceId: "source-carbon",
      origin: "https://erp.example",
      audience: "https://erp.example"
    });
    expect(() =>
      readCarbonSourceConfiguration({
        PORTAL_CARBON_SOURCE_JSON: '{"sourceId":"x","origin":"not a url"}'
      })
    ).toThrow();
  });
});
