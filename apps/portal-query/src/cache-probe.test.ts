import type { CacheStore } from "@carbon/portal/cache";
import { createTelemetry } from "@carbon/portal/telemetry";
import { describe, expect, it } from "vitest";
import { recordCacheIsolation, startCacheIsolationProbe } from "./cache-probe";

function memoryStore(): CacheStore {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    }
  };
}

function collect() {
  const records: { stage: string; outcome: string }[] = [];
  return {
    records,
    telemetry: createTelemetry("query", (record) => records.push(record))
  };
}

describe("cache isolation probe telemetry", () => {
  it("records a security success for an isolated store", async () => {
    const { records, telemetry } = collect();
    await expect(recordCacheIsolation(memoryStore(), telemetry)).resolves.toBe(
      "isolated"
    );
    expect(records).toEqual([
      expect.objectContaining({ stage: "security", outcome: "success" })
    ]);
  });

  it("records the cache-leakage security error only for an actual leak", async () => {
    // Every scope resolves to the same entry: a key-derivation regression.
    let last: Record<string, unknown> | undefined;
    const leaking: CacheStore = {
      get: async (key) => (last ? { ...last, key } : undefined),
      set: async (_key, value) => {
        last = value as Record<string, unknown>;
      }
    };
    const leak = collect();
    await expect(recordCacheIsolation(leaking, leak.telemetry)).resolves.toBe(
      "leak"
    );
    expect(leak.records).toEqual([
      expect.objectContaining({ stage: "security", outcome: "error" })
    ]);
    const outage = collect();
    const failing: CacheStore = {
      get: async () => {
        throw new Error("redis://cache.internal unreachable");
      },
      set: async () => {
        throw new Error("redis://cache.internal unreachable");
      }
    };
    await expect(recordCacheIsolation(failing, outage.telemetry)).resolves.toBe(
      "unavailable"
    );
    expect(outage.records).toEqual([
      expect.objectContaining({ stage: "cache", outcome: "error" })
    ]);
    expect(JSON.stringify(outage.records)).not.toContain("cache.internal");
  });

  it("starts only when a cache is configured and runs immediately", async () => {
    expect(startCacheIsolationProbe({})).toBeUndefined();
    const { records, telemetry } = collect();
    const probe = startCacheIsolationProbe(
      { PORTAL_REDIS_URL: "rediss://cache.example" },
      { store: memoryStore(), telemetry, intervalMs: 3_600_000 }
    );
    expect(probe).toBeDefined();
    try {
      await expect(probe?.run()).resolves.toBe("isolated");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(records.length).toBeGreaterThanOrEqual(2);
      expect(records.every((record) => record.stage === "security")).toBe(true);
    } finally {
      probe?.stop();
    }
  });
});
