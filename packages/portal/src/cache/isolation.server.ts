import { randomUUID } from "node:crypto";
import {
  AuthorizedCache,
  type CacheStore,
  type PolicySnapshot
} from "./cache.server";
import type { CacheScope } from "./keys";

export type IsolationVerdict = "isolated" | "leak" | "unavailable";

const PROBE_TTL_SECONDS = 30;

function probeScope(companyId: string, probe: string): CacheScope {
  return {
    companyId,
    actorId: `isolation-probe-${probe}`,
    callerId: "isolation-probe",
    capability: "portal.read",
    intent: "locate",
    entities: [],
    query: `isolation probe ${probe}`,
    locale: "en",
    businessTimezone: "UTC",
    modelVersion: "none",
    promptVersion: "probe",
    indexVersion: "probe"
  };
}

/**
 * Runtime cache-leakage self-test over the real store. Two synthetic scopes that
 * differ only by company must never share an entry, and a cached entry must be
 * refused once policy denies. A store outage or eviction is `unavailable`, never
 * reported as a leak, so the security alert fires only on an actual boundary failure.
 */
export async function verifyCacheIsolation(
  store: CacheStore
): Promise<IsolationVerdict> {
  const probe = randomUUID();
  try {
    const key = `portal:isolation-probe:${probe}`;
    await store.set(key, { probe }, PROBE_TTL_SECONDS);
    const echoed = (await store.get(key)) as { probe?: unknown } | undefined;
    if (echoed?.probe !== probe) return "unavailable";
  } catch {
    return "unavailable";
  }
  let allowed = true;
  const policy = async (): Promise<PolicySnapshot> => ({
    allowed,
    policyVersion: "probe",
    epochs: {}
  });
  const cache = new AuthorizedCache(store, policy);
  const decode = (value: unknown) => {
    if (typeof value !== "string") throw new Error("Invalid probe value");
    return value;
  };
  const read = async (companyId: string, value: string) => {
    let computed = false;
    const result = await cache.get(
      probeScope(companyId, probe),
      async () => {
        computed = true;
        return { value, evidenceIds: [] };
      },
      decode,
      async () => true
    );
    return { result, computed };
  };
  const first = await read(`isolation-probe-a-${probe}`, "a");
  const other = await read(`isolation-probe-b-${probe}`, "b");
  const again = await read(`isolation-probe-a-${probe}`, "x");
  if (first.result !== "a" || !first.computed) return "unavailable";
  if (other.result !== "b" || !other.computed) return "leak";
  if (again.computed) return "unavailable";
  if (again.result !== "a") return "leak";
  allowed = false;
  try {
    await read(`isolation-probe-a-${probe}`, "y");
  } catch {
    return "isolated";
  }
  return "leak";
}
