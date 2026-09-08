import Redis from "ioredis";
import type { CacheStore } from "./cache.server";

export function createRedisCache(url: string): {
  store: CacheStore;
  close: () => Promise<void>;
} {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "rediss:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("Remote cache requires TLS");
  }
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    commandTimeout: 500,
    enableOfflineQueue: false,
    retryStrategy: () => null
  });
  // Library connection errors carry endpoint details; use structured telemetry at callers.
  redis.on("error", () => {
    /* Callers report content-free dependency failures. */
  });
  let connecting: Promise<void> | undefined;
  let closed = false;
  async function ready() {
    if (closed) throw Error("Cache closed");
    if (redis.status === "ready") return;
    if (!connecting)
      connecting = redis.connect().finally(() => {
        connecting = undefined;
      });
    await connecting;
  }
  return {
    store: {
      async get(key) {
        await ready();
        const value = await redis.get(key);
        return value === null ? undefined : JSON.parse(value);
      },
      async set(key, value, ttlSeconds) {
        if (ttlSeconds < 1 || ttlSeconds > 60)
          throw new Error("Invalid cache TTL");
        await ready();
        await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
      }
    },
    async close() {
      closed = true;
      redis.disconnect();
    }
  };
}
