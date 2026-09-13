import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import Redis from "ioredis";
import type { CacheStore } from "./cache.server";

/** The answer cache never outlives its freshness budget. */
export const CACHE_MAX_TTL_SECONDS = 60;

export function createRedisCache(
  url: string,
  options: {
    /**
     * The longest TTL a caller may set. Defaults to the answer cache's
     * freshness budget; a store for follow-up context passes its own bound.
     */
    maxTtlSeconds?: number;
  } = {}
): {
  store: CacheStore;
  close: () => Promise<void>;
} {
  const maxTtlSeconds = options.maxTtlSeconds ?? CACHE_MAX_TTL_SECONDS;
  if (!Number.isInteger(maxTtlSeconds) || maxTtlSeconds < 1)
    throw new Error("Invalid cache TTL bound");
  const parsed = new URL(url);
  if (
    parsed.protocol !== "rediss:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("Remote cache requires TLS");
  }
  const caFile = process.env.PORTAL_REDIS_TLS_CA_FILE;
  let ca: string[] | undefined;
  if (caFile !== undefined) {
    if (parsed.protocol !== "rediss:")
      throw new Error("Redis TLS CA file requires a TLS URL");
    try {
      const pem = readFileSync(caFile, "utf8");
      const certificate =
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
      ca = pem.match(certificate) ?? undefined;
      if (!ca?.length || pem.replace(certificate, "").trim())
        throw new Error("Invalid certificate bundle");
      for (const entry of ca) new X509Certificate(entry);
    } catch {
      // Filesystem and certificate diagnostics can reveal private deployment inputs.
      throw new Error("Invalid Redis TLS CA file");
    }
  }
  const redis = new Redis(url, {
    ...(ca ? { tls: { ca, rejectUnauthorized: true } } : {}),
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
        if (
          !Number.isInteger(ttlSeconds) ||
          ttlSeconds < 1 ||
          ttlSeconds > maxTtlSeconds
        )
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
