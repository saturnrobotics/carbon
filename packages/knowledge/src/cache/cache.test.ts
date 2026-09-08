import { describe, expect, it } from "vitest";
import { AuthorizedCache, type PolicySnapshot } from "./cache.server";
import { cacheKey } from "./keys";

const scope = {
  companyId: "company-a",
  actorId: "alice",
  callerId: "query",
  capability: "query.read",
  intent: "locate",
  entities: ["motor-A"],
  query: "NEMA-34",
  locale: "en",
  businessTimezone: "America/New_York",
  modelVersion: "none",
  promptVersion: "1",
  indexVersion: "1"
};
const initial: PolicySnapshot = {
  allowed: true,
  policyVersion: "1",
  epochs: { "source-a:receipts": "1" }
};
function harness() {
  let policy = structuredClone(initial);
  let failCache = false;
  let count = 0;
  const values = new Map<string, unknown>();
  const cache = new AuthorizedCache(
    {
      get: async (key) => {
        if (failCache) throw new Error("Redis unavailable");
        return values.get(key);
      },
      set: async (key, value) => {
        if (failCache) throw new Error("Redis unavailable");
        values.set(key, value);
      }
    },
    async () => policy,
    () => 1000
  );
  const get = () =>
    cache.get(
      scope,
      async () => ({ value: ++count, evidenceIds: ["doc-a"] }),
      (value) => {
        if (typeof value !== "number") throw new Error("Invalid cache data");
        return value;
      },
      async () => policy.allowed
    );
  return {
    get,
    values,
    cache,
    get count() {
      return count;
    },
    setPolicy: (next: PolicySnapshot) => {
      policy = next;
    },
    failCache: () => {
      failCache = true;
    }
  };
}

describe("authorization-aware exact cache", () => {
  it("serves a warm result but denies it after revocation", async () => {
    const h = harness();
    expect(await h.get()).toBe(1);
    expect(await h.get()).toBe(1);
    h.setPolicy({ ...initial, allowed: false, policyVersion: "2" });
    await expect(h.get()).rejects.toThrow("Access denied");
    expect(h.count).toBe(1);
  });
  it("invalidates a query when a new matching row advances its family epoch", async () => {
    const h = harness();
    await h.get();
    h.setPolicy({ ...initial, epochs: { "source-a:receipts": "2" } });
    expect(await h.get()).toBe(2);
  });
  it("coalesces identical reads and survives Redis loss", async () => {
    const h = harness();
    expect(await Promise.all([h.get(), h.get()])).toEqual([1, 1]);
    h.failCache();
    expect(await h.get()).toBe(2);
  });
  it("cannot reuse another actor, company, model or engineering identifier", () => {
    const key = cacheKey(scope, initial);
    for (const changed of [
      { actorId: "bob" },
      { companyId: "company-b" },
      { query: "NEMA34" },
      { modelVersion: "2" }
    ]) {
      expect(cacheKey({ ...scope, ...changed }, initial)).not.toBe(key);
    }
  });
  it("fails closed when the policy store is unavailable", async () => {
    const cache = new AuthorizedCache(
      { get: async () => ({ value: "secret" }), set: async () => {} },
      async () => {
        throw new Error("policy unavailable");
      }
    );
    await expect(
      cache.get(
        scope,
        async () => ({ value: 1, evidenceIds: [] }),
        Number,
        async () => true
      )
    ).rejects.toThrow();
  });
});
