import { describe, expect, it } from "vitest";
import type { CacheStore } from "./cache.server";
import { verifyCacheIsolation } from "./isolation.server";

function memoryStore(): CacheStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    }
  };
}

describe("runtime cache isolation probe", () => {
  it("reports an isolated store", async () => {
    const store = memoryStore();
    await expect(verifyCacheIsolation(store)).resolves.toBe("isolated");
    expect(
      [...store.values.keys()].every((key) => key.startsWith("portal:"))
    ).toBe(true);
  });

  it("reports a store that serves another company's entry under the requested key as a leak", async () => {
    // Models a key-derivation regression: every scope resolves to the same entry.
    let last: Record<string, unknown> | undefined;
    const leaking: CacheStore = {
      get: async (key) => (last ? { ...last, key } : undefined),
      set: async (_key, value) => {
        last = value as Record<string, unknown>;
      }
    };
    await expect(verifyCacheIsolation(leaking)).resolves.toBe("leak");
  });

  it("treats a store that returns an entry for a different key as a miss, not a leak", async () => {
    const store = memoryStore();
    let last: unknown;
    const mislabelled: CacheStore = {
      get: async (key) =>
        key.startsWith("portal:isolation-probe:") ? store.get(key) : last,
      set: async (key, value, ttl) => {
        last = value;
        await store.set(key, value, ttl);
      }
    };
    await expect(verifyCacheIsolation(mislabelled)).resolves.toBe(
      "unavailable"
    );
  });

  it("reports an outage or eviction as unavailable rather than a leak", async () => {
    const failing: CacheStore = {
      get: async () => {
        throw new Error("Redis unavailable");
      },
      set: async () => {
        throw new Error("Redis unavailable");
      }
    };
    await expect(verifyCacheIsolation(failing)).resolves.toBe("unavailable");
    const evicting = memoryStore();
    const probeOnly: CacheStore = {
      get: async (key) =>
        key.startsWith("portal:isolation-probe:")
          ? evicting.get(key)
          : undefined,
      set: evicting.set
    };
    await expect(verifyCacheIsolation(probeOnly)).resolves.toBe("unavailable");
  });
});
