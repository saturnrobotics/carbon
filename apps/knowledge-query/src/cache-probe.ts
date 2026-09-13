import type { CacheStore } from "@carbon/knowledge/cache";
import {
  type IsolationVerdict,
  verifyCacheIsolation
} from "@carbon/knowledge/cache/isolation.server";
import { createRedisCache } from "@carbon/knowledge/cache/redis.server";
import { createTelemetry, type Telemetry } from "@carbon/knowledge/telemetry";

export const CACHE_PROBE_INTERVAL_MS = 300_000;

/**
 * A leak is a `security` error (the cache-leakage alert); an isolated store is a
 * `security` success; an unreachable store is a `cache` error, which the existing
 * cache alert already covers, so an outage can never masquerade as a leak.
 */
export async function recordCacheIsolation(
  store: CacheStore,
  telemetry: Pick<Telemetry, "record">
): Promise<IsolationVerdict> {
  const started = performance.now();
  let verdict: IsolationVerdict;
  try {
    verdict = await verifyCacheIsolation(store);
  } catch {
    verdict = "unavailable";
  }
  const durationMs = performance.now() - started;
  if (verdict === "leak") telemetry.record("security", "error", { durationMs });
  else if (verdict === "isolated")
    telemetry.record("security", "success", { durationMs });
  else telemetry.record("cache", "error", { durationMs });
  return verdict;
}

/** Runs once at start and then on an interval; returns nothing when no cache is configured. */
export function startCacheIsolationProbe(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    store?: CacheStore;
    telemetry?: Pick<Telemetry, "record">;
    intervalMs?: number;
  } = {}
): { run: () => Promise<IsolationVerdict>; stop: () => void } | undefined {
  const url = environment.KNOWLEDGE_REDIS_URL?.trim();
  const store =
    options.store ?? (url ? createRedisCache(url).store : undefined);
  if (!store) return undefined;
  const telemetry = options.telemetry ?? createTelemetry("query");
  const run = () => recordCacheIsolation(store, telemetry);
  void run();
  const timer = setInterval(run, options.intervalMs ?? CACHE_PROBE_INTERVAL_MS);
  timer.unref();
  return { run, stop: () => clearInterval(timer) };
}
