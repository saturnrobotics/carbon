import { describe, expect, it } from "vitest";
import { AuthorizedCache } from "../cache/cache.server";
import { cacheKey } from "../cache/keys";

const scope = {
  companyId: "cmp_alpha",
  actorId: "usr_alex",
  callerId: "portal",
  capability: "knowledge.read",
  intent: "locate",
  entities: ["source-alpha"],
  query: "MTR-100",
  locale: "en",
  businessTimezone: "UTC",
  modelVersion: "locate-no-model",
  promptVersion: "query-v1",
  indexVersion: "lexical-v1"
};
const policy = {
  allowed: true,
  policyVersion: "binding:1",
  epochs: { "source-alpha:acl": "1" }
};
const clock = () => 1_000_000;

function harness(store = new Map<string, unknown>()) {
  let computed = 0;
  const cache = new AuthorizedCache(
    {
      get: async (key) => store.get(key),
      set: async (key, value) => void store.set(key, value)
    },
    async () => policy,
    clock
  );
  const read = (
    actorId: string,
    authorized: (ids: string[]) => Promise<boolean> = async () => true
  ) =>
    cache.get(
      { ...scope, actorId },
      async () => {
        computed += 1;
        return {
          value: `result-for-${actorId}`,
          evidenceIds: [`chunk-${actorId}`]
        };
      },
      (value) => {
        if (typeof value !== "string") throw new Error("Invalid cache data");
        return value;
      },
      authorized
    );
  return { store, read, computed: () => computed };
}

describe("cache poisoning across users", () => {
  it("never serves one actor's entry to another actor with the same query", async () => {
    const h = harness();
    expect(await h.read("usr_alex")).toBe("result-for-usr_alex");
    expect(await h.read("usr_blair")).toBe("result-for-usr_blair");
    expect(h.computed()).toBe(2);
    expect(h.store.size).toBe(2);
  });

  it("refuses a planted entry whose evidence the actor cannot read", async () => {
    const h = harness();
    const key = cacheKey(scope, policy);
    h.store.set(key, {
      schema: 1,
      key,
      expiresAt: clock() + 30_000,
      evidenceIds: ["chunk-usr_blair"],
      value: "result-for-usr_blair"
    });
    await expect(
      h.read("usr_alex", async (ids) =>
        ids.every((id) => id === "chunk-usr_alex")
      )
    ).rejects.toThrow("Access denied or source version changed");
    expect(h.computed()).toBe(0);
  });

  it("ignores envelopes that were written under a different key or lifetime", async () => {
    const h = harness();
    const key = cacheKey(scope, policy);
    const planted = (patch: Record<string, unknown>) =>
      h.store.set(key, {
        schema: 1,
        key,
        expiresAt: clock() + 30_000,
        evidenceIds: ["chunk-usr_alex"],
        value: "planted",
        ...patch
      });
    planted({ key: cacheKey({ ...scope, actorId: "usr_blair" }, policy) });
    expect(await h.read("usr_alex")).toBe("result-for-usr_alex");
    planted({ expiresAt: clock() + 600_000 });
    expect(await h.read("usr_alex")).toBe("result-for-usr_alex");
    planted({
      evidenceIds: Array.from({ length: 9 }, (_, index) => `chunk-${index}`)
    });
    expect(await h.read("usr_alex")).toBe("result-for-usr_alex");
    planted({ value: { injected: true } });
    expect(await h.read("usr_alex")).toBe("result-for-usr_alex");
    expect(h.computed()).toBe(4);
  });

  it("changes the key when policy or source epochs move, orphaning older entries", () => {
    const key = cacheKey(scope, policy);
    expect(cacheKey(scope, { ...policy, policyVersion: "binding:2" })).not.toBe(
      key
    );
    expect(
      cacheKey(scope, { ...policy, epochs: { "source-alpha:acl": "2" } })
    ).not.toBe(key);
    expect(cacheKey({ ...scope, companyId: "cmp_beta" }, policy)).not.toBe(key);
    expect(cacheKey({ ...scope, callerId: "worker" }, policy)).not.toBe(key);
  });
});
