import { type CacheScope, cacheKey } from "./keys";
export type PolicySnapshot = {
  allowed: boolean;
  policyVersion: string;
  epochs: Record<string, string>;
};
export type CacheStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
};
type Envelope = {
  schema: 1;
  key: string;
  expiresAt: number;
  evidenceIds: string[];
  value: unknown;
};
function envelope(
  value: unknown,
  key: string,
  now: number
): Envelope | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Partial<Envelope>;
  if (
    row.schema !== 1 ||
    row.key !== key ||
    typeof row.expiresAt !== "number" ||
    row.expiresAt <= now ||
    row.expiresAt > now + 60000 ||
    !Array.isArray(row.evidenceIds) ||
    row.evidenceIds.length > 8 ||
    row.evidenceIds.some((id) => typeof id !== "string" || id.length > 256)
  )
    return;
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536) return;
  return row as Envelope;
}

const inFlight = new Map<string, Promise<Envelope>>();

export class AuthorizedCache {
  constructor(
    private readonly store: CacheStore,
    private readonly policy: (scope: CacheScope) => Promise<PolicySnapshot>,
    private readonly clock = () => performance.timeOrigin + performance.now()
  ) {}
  async get<T>(
    scope: CacheScope,
    compute: () => Promise<{
      value: T;
      evidenceIds: string[];
      cacheable?: boolean;
    }>,
    decode: (value: unknown) => T,
    authorizeEvidence: (ids: string[]) => Promise<boolean>
  ): Promise<T> {
    const initial = await this.policy(scope);
    if (!initial.allowed) throw new Error("Access denied");
    const key = cacheKey(scope, initial);
    let hit: Envelope | undefined;
    try {
      hit = envelope(await this.store.get(key), key, this.clock());
    } catch {
      /* Cache failure is a miss, never a policy bypass. */
    }
    if (hit) {
      try {
        decode(hit.value);
      } catch {
        hit = undefined;
      }
    }
    if (!hit) {
      let pending = inFlight.get(key);
      if (!pending) {
        if (inFlight.size >= 128)
          throw new Error("Query concurrency limit reached");
        pending = (async () => {
          const computed = await compute();
          decode(computed.value);
          const candidate: Envelope = {
            schema: 1,
            key,
            expiresAt: this.clock() + 60000,
            value: computed.value,
            evidenceIds: computed.evidenceIds
          };
          const current = await this.policy(scope);
          if (!current.allowed || cacheKey(scope, current) !== key)
            throw new Error(
              "Authorization or source version changed; retry request"
            );
          if (!(await authorizeEvidence(candidate.evidenceIds)))
            throw new Error("Access denied");
          if (
            computed.cacheable !== false &&
            envelope(candidate, key, this.clock())
          ) {
            // Small downward-only jitter never extends the freshness budget.
            const ttl = 55 + Math.floor(Math.random() * 5);
            candidate.expiresAt = this.clock() + ttl * 1000;
            try {
              await this.store.set(key, candidate, ttl);
            } catch {
              /* Authoritative result remains usable. */
            }
          }
          return candidate;
        })().finally(() => {
          inFlight.delete(key);
        });
        inFlight.set(key, pending);
      }
      hit = await pending;
    }
    // Every waiting caller and every cache hit rechecks policy before delivery.
    const finalPolicy = await this.policy(scope);
    if (
      !finalPolicy.allowed ||
      cacheKey(scope, finalPolicy) !== key ||
      !(await authorizeEvidence(hit.evidenceIds))
    )
      throw new Error("Access denied or source version changed");
    return decode(hit.value);
  }
}
