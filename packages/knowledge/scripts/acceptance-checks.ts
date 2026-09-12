/**
 * A01–A15 acceptance checks. Every check runs against synthetic fixtures with no
 * cloud or provider access. In-process checks exercise the real package modules;
 * database-backed checks require the explicitly labelled disposable PostgreSQL.
 * A check passes by returning details and fails by throwing.
 */
import type pg from "pg";
import { AuthorizedCache, type PolicySnapshot } from "../src/cache/cache.server";
import { cacheKey } from "../src/cache/keys";
import {
  assertExecutableTicketCommand,
  ticketCommandPayloadHash
} from "../src/commands/ticket";
import { queryRequestSchema } from "../src/contracts";
import { withKnowledgeTransaction } from "../src/database.server";
import { resolveReceivedManual } from "../src/entities/resolve";
import {
  type IdentityBinding,
  type TrustedCallerConfiguration,
  type TrustedTokenVerifier,
  type VerifiedTokenClaims,
  verifyIapBrowserRequest,
  verifyWorkforceRequest
} from "../src/identity.server";
import { captureIdentity } from "../src/intake/intake.server";
import { reconcileExtraction } from "../src/intake/reconciliation";
import { executeReadQuery } from "../src/query/answer.server";
import { routeQuery } from "../src/query/router";
import { lexicalSearch } from "../src/retrieval/lexical.server";
import {
  createSourceRegistry,
  sourceRegistryConfigurationSchema
} from "../src/sources/registry.server";
import { createTelemetry } from "../src/telemetry";
import type { PerformanceReport } from "./performance-fixture";
import {
  compareDeployment,
  compareIsolation,
  type ObservedTarget,
  type ReleaseManifest
} from "./verify-deployment";

export type CheckContext = {
  expected: Record<string, unknown>;
  database?: { readPool: pg.Pool; adminPool: pg.Pool };
  performance?: () => Promise<PerformanceReport>;
};
export type CheckDetails = Record<string, unknown>;
export type Check = (context: CheckContext) => Promise<CheckDetails>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function number(context: CheckContext, key: string): number {
  const value = context.expected[key];
  assert(
    typeof value === "number" && Number.isFinite(value),
    `acceptance case expects numeric ${key}`
  );
  return value;
}

function database(context: CheckContext) {
  assert(context.database, "database-backed check requires the disposable database");
  return context.database;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

// Synthetic identity fixtures shared by the in-process identity checks.
const now = 2_000_000_000;
const receiverAudience = "https://query.example.test";
const sourceAudience = "/projects/000000000000/global/backendServices/portal";
const configuration: TrustedCallerConfiguration = {
  version: 1,
  receiver: { id: "query", audience: receiverAudience },
  callers: [
    {
      callerId: "portal",
      serviceAccountSubject: "100000000000000000001",
      sourceIapAudience: sourceAudience,
      operations: ["knowledge.query"],
      capabilities: ["knowledge.read"],
      requiredAccessLevels: ["accessPolicies/000/accessLevels/managed-device"]
    }
  ]
};
const serviceClaims: VerifiedTokenClaims = {
  iss: "https://accounts.google.com",
  sub: "100000000000000000001",
  aud: receiverAudience,
  iat: now - 30,
  exp: now + 300
};
const iapClaims: VerifiedTokenClaims = {
  iss: "https://cloud.google.com/iap",
  sub: "accounts.google.com:100000000000000000099",
  aud: sourceAudience,
  iat: now - 30,
  exp: now + 300,
  google: {
    access_levels: ["accessPolicies/000/accessLevels/managed-device"]
  }
};
const binding: IdentityBinding = {
  actorId: "usr_synthetic_alex",
  companyId: "cmp_alpha",
  companyGroupId: "group_alpha",
  bindingActive: true,
  userActive: true,
  membershipActive: true,
  revocationVersion: 1,
  permissionsVersion: "permissions-1",
  capabilities: ["knowledge.read"]
};
function verifier(
  service: VerifiedTokenClaims = serviceClaims,
  iap: VerifiedTokenClaims = iapClaims
): TrustedTokenVerifier {
  return {
    verifyServiceToken: async () => service,
    verifyIapToken: async () => iap
  };
}
function workforceRequest(headers: Record<string, string> = {}) {
  return new Request("https://query.example.test/v1/query", {
    method: "POST",
    headers: {
      authorization: "Bearer service-token",
      "x-portal-user-evidence": "iap-token",
      "x-portal-company-id": "cmp_alpha",
      ...headers
    }
  });
}
const principal = {
  kind: "human" as const,
  actorId: "usr_synthetic_alex",
  companyId: "cmp_alpha",
  callerId: "portal",
  sourceIdentity: {
    issuer: "https://cloud.google.com/iap",
    subject: "accounts.google.com:100000000000000000099"
  },
  policyVersion: "identity-1:permissions-1",
  capabilities: ["knowledge.read"]
};
const locateRequest = {
  requestId: "acceptance-request",
  text: "find the MTR-100 motor manual",
  mode: "locate" as const,
  locale: "en"
};
function evidence(id: string, excerpt: string) {
  return {
    id,
    sourceId: "source-alpha",
    documentVersionId: `version-${id}`,
    sourceRevision: "1",
    title: `Manual ${id}`,
    excerpt,
    sourceUri: `https://portal.example.test/documents/doc-${id}/versions/version-${id}`,
    observedAt: "2026-09-01T00:00:00Z",
    policyVersion: "1",
    freshness: "current" as const
  };
}
const cacheScope = {
  companyId: "cmp_alpha",
  actorId: "usr_synthetic_alex",
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
const policyAllowed: PolicySnapshot = {
  allowed: true,
  policyVersion: "binding:1",
  epochs: { "source-alpha:content": "1", "source-alpha:acl": "1" }
};

/** Read as the restricted role through the real session-claim transaction. */
function readAs<T>(
  pool: pg.Pool,
  actorId: string,
  companyId: string,
  operation: Parameters<typeof withKnowledgeTransaction<T>>[3]
) {
  return withKnowledgeTransaction(
    pool,
    { companyId, actorId, callerId: "acceptance" },
    "read",
    operation
  );
}

async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "success";
  } catch (error) {
    return error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "error";
  }
}

async function rolledBack(
  pool: pg.Pool,
  role: string,
  statement: string
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    return await sqlState(client.query(statement));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const freshFixture = {
  documentId: "acceptance_doc_fresh",
  versionId: "acceptance_version_fresh",
  chunkId: "acceptance_chunk_fresh",
  term: "acceptancefreshword"
};

async function removeFreshFixture(adminPool: pg.Pool) {
  await adminPool.query(
    `DELETE FROM knowledge.chunk WHERE "companyId"='company-a' AND "documentId"=$1`,
    [freshFixture.documentId]
  );
  await adminPool.query(
    `DELETE FROM knowledge."grant" WHERE "companyId"='company-a' AND "documentId"=$1`,
    [freshFixture.documentId]
  );
  await adminPool.query(
    `UPDATE knowledge.document SET "currentVersionId"=NULL,version=version+1 WHERE "companyId"='company-a' AND id=$1`,
    [freshFixture.documentId]
  );
  await adminPool.query(
    `DELETE FROM knowledge."documentVersion" WHERE "companyId"='company-a' AND "documentId"=$1`,
    [freshFixture.documentId]
  );
  await adminPool.query(
    `DELETE FROM knowledge.document WHERE "companyId"='company-a' AND id=$1`,
    [freshFixture.documentId]
  );
}

async function untilMs(
  condition: () => Promise<boolean>,
  limitMs: number
): Promise<number> {
  const started = performance.now();
  for (;;) {
    if (await condition()) return performance.now() - started;
    if (performance.now() - started > limitMs) return Number.POSITIVE_INFINITY;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const observedTarget = (
  services: Record<string, Record<string, string>>,
  extra: Partial<ObservedTarget> = {}
): ObservedTarget => ({
  schemaVersion: 1,
  observedAt: "2026-09-11T00:00:00Z",
  target: "synthetic",
  services,
  migrations: { head: "20260908050421_ingest-source-visibility-execute.sql", count: 33 },
  database: { startedAt: "2026-09-10T00:00:00Z" },
  ...extra
});

function liveOnly(reason: string): Check {
  return async () => {
    throw new Error(`${reason}; the evaluator reports this case as skipped`);
  };
}

export const checks: Record<string, Check> = {
  "cloud-identity-sign-in": liveOnly("requires live Google IAP sign-in"),
  "cloud-model-latency": liveOnly("requires the managed model provider"),
  "cloud-iap-overhead": liveOnly("requires the external IAP boundary"),
  "kanban-ticket-creation": liveOnly("requires the Kanban service"),

  async "identity-denial-matrix"() {
    const denied: string[] = [];
    const attempts: Array<[string, () => Promise<unknown>]> = [
      [
        "unknown identity",
        () =>
          verifyWorkforceRequest({
            request: workforceRequest(),
            operation: "knowledge.query",
            configuration,
            tokenVerifier: verifier(),
            identityStore: { resolveHuman: async () => null },
            nowEpochSeconds: now
          })
      ],
      [
        "wrong company",
        () =>
          verifyWorkforceRequest({
            request: workforceRequest({ "x-portal-company-id": "cmp_beta" }),
            operation: "knowledge.query",
            configuration,
            tokenVerifier: verifier(),
            identityStore: { resolveHuman: async () => binding },
            nowEpochSeconds: now
          })
      ],
      [
        "forged actor header",
        () =>
          verifyWorkforceRequest({
            request: workforceRequest({ "x-portal-actor-id": "usr_forged" }),
            operation: "knowledge.query",
            configuration,
            tokenVerifier: verifier(),
            identityStore: { resolveHuman: async () => binding },
            nowEpochSeconds: now
          })
      ],
      [
        "wrong service audience",
        () =>
          verifyWorkforceRequest({
            request: workforceRequest(),
            operation: "knowledge.query",
            configuration,
            tokenVerifier: verifier({
              ...serviceClaims,
              aud: "https://other.example.test"
            }),
            identityStore: { resolveHuman: async () => binding },
            nowEpochSeconds: now
          })
      ],
      [
        "wrong user audience",
        () =>
          verifyWorkforceRequest({
            request: workforceRequest(),
            operation: "knowledge.query",
            configuration,
            tokenVerifier: verifier(serviceClaims, {
              ...iapClaims,
              aud: "/projects/other"
            }),
            identityStore: { resolveHuman: async () => binding },
            nowEpochSeconds: now
          })
      ],
      [
        "unauthorized service account",
        () =>
          verifyWorkforceRequest({
            request: workforceRequest(),
            operation: "knowledge.query",
            configuration,
            tokenVerifier: verifier({
              ...serviceClaims,
              sub: "100000000000000000002"
            }),
            identityStore: { resolveHuman: async () => binding },
            nowEpochSeconds: now
          })
      ],
      [
        "revoked membership",
        () =>
          verifyWorkforceRequest({
            request: workforceRequest(),
            operation: "knowledge.query",
            configuration,
            tokenVerifier: verifier(),
            identityStore: {
              resolveHuman: async () => ({ ...binding, membershipActive: false })
            },
            nowEpochSeconds: now
          })
      ],
      [
        "browser without assertion",
        () =>
          verifyIapBrowserRequest({
            request: new Request("https://portal.example.test/"),
            sourceIapAudience: sourceAudience,
            tokenVerifier: verifier(),
            nowEpochSeconds: now
          })
      ],
      [
        "browser delegation header",
        () =>
          verifyIapBrowserRequest({
            request: new Request("https://portal.example.test/", {
              headers: {
                "x-goog-iap-jwt-assertion": "iap-token",
                "x-portal-company-id": "cmp_alpha"
              }
            }),
            sourceIapAudience: sourceAudience,
            tokenVerifier: verifier(),
            nowEpochSeconds: now
          })
      ]
    ];
    for (const [name, attempt] of attempts) {
      let outcome = "allowed";
      try {
        await attempt();
      } catch (error) {
        outcome = error instanceof Error ? error.message : "denied";
      }
      assert(/unauthorized/.test(outcome), `${name} was not denied`);
      denied.push(name);
    }
    const allowed = await verifyWorkforceRequest({
      request: workforceRequest(),
      operation: "knowledge.query",
      configuration,
      tokenVerifier: verifier(),
      identityStore: { resolveHuman: async () => binding },
      nowEpochSeconds: now
    });
    assert(
      allowed.principal.actorId === binding.actorId,
      "control identity was not resolved"
    );
    return { denied, controlActor: allowed.principal.actorId };
  },

  async "unauthorized-documents-database"(context) {
    const { readPool } = database(context);
    const visible = await readAs(readPool, "alice", "company-a", async (client) =>
      (await client.query<{ id: string }>("SELECT id FROM knowledge.document ORDER BY id")).rows.map((row) => row.id)
    );
    const otherCompany = await readAs(readPool, "alice", "company-b", async (client) =>
      (await client.query<{ id: string }>("SELECT id FROM knowledge.document")).rows.length
    );
    const revoked = await readAs(readPool, "revoked", "company-a", async (client) =>
      (await client.query<{ id: string }>("SELECT id FROM knowledge.document")).rows.length
    );
    assert(
      visible.length === 1 && visible[0] === "doc-a",
      `alice sees ${JSON.stringify(visible)} instead of only doc-a`
    );
    assert(otherCompany === 0, "company selection granted membership");
    assert(revoked === 0, "revoked binding still reads documents");
    return { visible, otherCompany, revoked };
  },

  async "deployment-noop-and-isolation"() {
    const manifest: ReleaseManifest = {
      generation: 4,
      services: {
        "knowledge-web": { revision_digest: "sha256:web-1", image_digest: "sha256:img-web-1", deployed_revision: "knowledge-web-00001" },
        "knowledge-query": { revision_digest: "sha256:query-1", image_digest: "sha256:img-query-1", deployed_revision: "knowledge-query-00001" }
      }
    };
    const observed = observedTarget({
      "knowledge-web": { revision_digest: "sha256:web-1", image_digest: "sha256:img-web-1", deployed_revision: "knowledge-web-00001" },
      "knowledge-query": { revision_digest: "sha256:query-1", image_digest: "sha256:img-query-1", deployed_revision: "knowledge-query-00001" }
    });
    const noop = compareDeployment(manifest, observed);
    assert(noop.ok && noop.services.every((row) => row.status === "match"), "same-input deployment reported drift");
    const webOnly = observedTarget({
      "knowledge-web": { revision_digest: "sha256:web-2", image_digest: "sha256:img-web-2", deployed_revision: "knowledge-web-00002" },
      "knowledge-query": { revision_digest: "sha256:query-1", image_digest: "sha256:img-query-1", deployed_revision: "knowledge-query-00001" }
    });
    const isolation = compareIsolation(observed, webOnly, ["knowledge-web"]);
    assert(isolation.ok, `web-only edit disturbed ${JSON.stringify(isolation.services.filter((row) => row.status !== "untouched" && row.status !== "changed"))}`);
    assert(isolation.migrationsUnchanged && isolation.databaseUptimePreserved, "web-only edit changed schema or database uptime");
    const restartedQuery = observedTarget({
      "knowledge-web": webOnly.services["knowledge-web"]!,
      "knowledge-query": { ...observed.services["knowledge-query"]!, deployed_revision: "knowledge-query-00002" }
    });
    const violation = compareIsolation(observed, restartedQuery, ["knowledge-web"]);
    assert(!violation.ok, "an unrelated service restart was not detected");
    return { noop: noop.services.length, webOnly: isolation.services.map((row) => `${row.name}:${row.status}`) };
  },

  async "warm-lookup-latency-database"(context) {
    assert(context.performance, "warm lookup latency requires the performance fixture");
    const report = await context.performance();
    const limit = number(context, "p95Ms");
    const phases = { exact: report.phases["warm:exact-acl"]!, lexical: report.phases["warm:lexical"]! };
    assert(phases.exact.p95Ms <= limit && phases.lexical.p95Ms <= limit, `warm p95 exceeded ${limit}ms: exact ${phases.exact.p95Ms}, lexical ${phases.lexical.p95Ms}`);
    assert(phases.exact.errors === 0 && phases.lexical.errors === 0, "warm path produced errors");
    return { scope: report.scope, exactAclP95Ms: phases.exact.p95Ms, lexicalP95Ms: phases.lexical.p95Ms, excluded: "IAP, HTTP, portal, browser" };
  },

  async "uncached-read-latency-database"(context) {
    assert(context.performance, "uncached read latency requires the performance fixture");
    const report = await context.performance();
    const limit = number(context, "p95Ms");
    const cold = report.phases["cold:lexical"]!;
    assert(cold.p95Ms <= limit, `cold lexical p95 ${cold.p95Ms}ms exceeded ${limit}ms`);
    assert(cold.errors === 0, "cold path produced errors");
    return { scope: report.scope, coldLexicalP95Ms: cold.p95Ms, coldDefinition: report.coldDefinition };
  },

  async "local-auth-policy-overhead"(context) {
    const limit = number(context, "p95Ms");
    const iterations = 200;
    const store = new Map<string, unknown>();
    const cache = new AuthorizedCache({ get: async (key) => store.get(key), set: async (key, value) => void store.set(key, value) }, async () => policyAllowed);
    const durations: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const identity = await verifyWorkforceRequest({ request: workforceRequest(), operation: "knowledge.query", configuration, tokenVerifier: verifier(), identityStore: { resolveHuman: async () => binding }, nowEpochSeconds: now });
      await cache.get(cacheScope, async () => ({ value: identity.principal.actorId, evidenceIds: ["chunk-a"] }), String, async () => true);
      durations.push(performance.now() - started);
    }
    const p95Ms = percentile(durations, 0.95);
    assert(p95Ms <= limit, `local auth/policy p95 ${p95Ms}ms exceeded ${limit}ms`);
    return { iterations, p50Ms: percentile(durations, 0.5), p95Ms, excluded: "external IAP boundary" };
  },

  async "ambiguous-fixture-abstains"() {
    const receipt = (id: string, revision: string) => ({ id, itemId: "item-mtr-100", revision, manufacturer: "Example Motors", mpn: "MTR-100", receivedAt: "2026-09-01T00:00:00Z", quantity: "1", reversedQuantity: "0", posted: true, voided: false });
    const link = (revision: string, version: string) => ({ documentVersionId: version, itemId: "item-mtr-100", revision, manufacturer: "Example Motors", mpn: "MTR-100", verified: true });
    const twoRevisions = resolveReceivedManual([receipt("r1", "A"), receipt("r2", "B")], [link("A", "v-a"), link("B", "v-b")]);
    const twoManuals = resolveReceivedManual([receipt("r1", "A")], [link("A", "v-a"), link("A", "v-a2")]);
    const exact = resolveReceivedManual([receipt("r1", "A")], [link("A", "v-a")]);
    assert(twoRevisions.status === "ambiguous" && twoManuals.status === "ambiguous", "ambiguous fixture produced a confident selection");
    assert(exact.status === "resolved" && exact.documentVersionId === "v-a", "exact fixture was not resolved");
    return { twoRevisions: twoRevisions.status, twoManuals: twoManuals.status, exact: exact.status };
  },

  async "known-item-recall-database"(context) {
    assert(context.performance, "known-item recall requires the performance fixture");
    const report = await context.performance();
    const minimum = number(context, "recallAt10");
    const lexical = { cold: report.phases["cold:lexical"]!, warm: report.phases["warm:lexical"]! };
    assert(lexical.cold.recallAt10 >= minimum && lexical.warm.recallAt10 >= minimum, `authorized Recall@10 below ${minimum}: cold ${lexical.cold.recallAt10}, warm ${lexical.warm.recallAt10}`);
    return { questions: lexical.warm.count, coldRecallAt10: lexical.cold.recallAt10, warmRecallAt10: lexical.warm.recallAt10 };
  },

  async "claims-require-resolvable-evidence"() {
    const supported = await executeReadQuery({ ...locateRequest, mode: "read" }, principal, { retrieve: async () => [evidence("chunk-a", "Torque the terminal screws to 2 Nm.")], authorize: async () => true, synthesize: async () => ({ claims: [{ text: "Terminal screws take 2 Nm.", evidenceIds: ["chunk-a"] }] }) });
    const fabricated = await executeReadQuery({ ...locateRequest, mode: "read" }, principal, { retrieve: async () => [evidence("chunk-a", "Torque the terminal screws to 2 Nm.")], authorize: async () => true, synthesize: async () => ({ claims: [{ text: "Unsupported", evidenceIds: ["chunk-missing"] }] }) });
    const conflicting = await executeReadQuery({ ...locateRequest, mode: "read" }, principal, { retrieve: async () => [evidence("chunk-a", "Torque to 2 Nm."), evidence("chunk-b", "Torque to 4 Nm.")], authorize: async () => true, synthesize: async () => ({ claims: [] }) });
    const unsupported = await executeReadQuery({ ...locateRequest, mode: "read" }, principal, { retrieve: async () => [], authorize: async () => true, synthesize: async () => { throw new Error("model must not run without evidence"); } });
    assert(supported.kind === "answer" && supported.claims.every((claim) => claim.evidenceIds.every((id) => supported.evidence.some((item) => item.id === id))), "answer claim lacks resolvable evidence");
    assert(fabricated.kind === "abstention" && fabricated.claims.length === 0, "fabricated citation was not rejected");
    assert(conflicting.kind === "abstention" && /did not support/.test(conflicting.message), "conflicting evidence did not abstain");
    assert(unsupported.kind === "abstention" && unsupported.evidence.length === 0, "unsupported case did not abstain");
    return { supported: supported.kind, fabricated: fabricated.kind, conflicting: conflicting.kind, unsupported: unsupported.kind };
  },

  async "no-cross-user-leakage"() {
    const key = cacheKey(cacheScope, policyAllowed);
    const isolated = Object.entries({ actorId: "usr_synthetic_blair", companyId: "cmp_beta", callerId: "worker", capability: "knowledge.intake.review", query: "MTR-100 " }).filter(([field, value]) => cacheKey({ ...cacheScope, [field]: value }, policyAllowed) !== key).map(([field]) => field);
    assert(isolated.length === 4 && !isolated.includes("query"), "cache key does not isolate actor, company, caller and capability while normalizing whitespace");
    const visibleOnly = await executeReadQuery(locateRequest, principal, { retrieve: async () => [evidence("chunk-a", "visible")], authorize: async () => true });
    const withHidden = await executeReadQuery(locateRequest, principal, { retrieve: async () => [evidence("chunk-a", "visible"), evidence("chunk-hidden", "restricted excerpt")], authorize: async (item) => item.id !== "chunk-hidden" });
    const onlyHidden = await executeReadQuery(locateRequest, principal, { retrieve: async () => [evidence("chunk-hidden", "restricted excerpt")], authorize: async () => false });
    const nothing = await executeReadQuery(locateRequest, principal, { retrieve: async () => [], authorize: async () => true });
    assert(JSON.stringify(withHidden) === JSON.stringify(visibleOnly), "a hidden match changed counts or snippets");
    assert(JSON.stringify(onlyHidden) === JSON.stringify(nothing), "a hidden-only match differs from no match");
    assert(!JSON.stringify(withHidden).includes("restricted"), "hidden excerpt leaked");
    const events: unknown[] = [];
    const telemetry = createTelemetry("query", (event) => void events.push(event));
    telemetry.record("retrieval", "success", { durationMs: 3, count: 1, query: "MTR-100", excerpt: "restricted excerpt" } as never);
    assert(!JSON.stringify(events).includes("MTR-100") && !JSON.stringify(events).includes("restricted"), "telemetry accepted content fields");
    const poisoned = new Map<string, unknown>([[key, { schema: 1, key, expiresAt: Date.now() + 30_000, evidenceIds: ["chunk-hidden"], value: { requestId: "x", kind: "results", evidence: [], claims: [], message: "", partial: false } }]]);
    const cache = new AuthorizedCache({ get: async (id) => poisoned.get(id), set: async () => undefined }, async () => policyAllowed);
    const outcome = await cache.get(cacheScope, async () => ({ value: "recomputed", evidenceIds: [] }), (value) => value as string, async (ids) => ids.length === 0).catch((error: Error) => `denied:${error.message}`);
    assert(outcome === "denied:Access denied or source version changed", "poisoned cache entry with foreign evidence was delivered");
    return { isolatedFields: isolated, hiddenInvisible: true, telemetryFields: Object.keys(events[0] as object), poisonedEntry: outcome };
  },

  async "local-revocation-cache"(context) {
    const limitMs = number(context, "withinMs");
    let policy = policyAllowed;
    const store = new Map<string, unknown>();
    const cache = new AuthorizedCache({ get: async (key) => store.get(key), set: async (key, value) => void store.set(key, value) }, async () => policy);
    const read = () => cache.get(cacheScope, async () => ({ value: "manual", evidenceIds: ["chunk-a"] }), String, async () => policy.allowed);
    assert((await read()) === "manual" && (await read()) === "manual", "warm path did not serve");
    const started = performance.now();
    policy = { ...policyAllowed, allowed: false, policyVersion: "revoked" };
    const outcome = await read().catch((error: Error) => error.message);
    const elapsedMs = performance.now() - started;
    assert(outcome === "Access denied", "revoked policy still served a warm hit");
    assert(elapsedMs <= limitMs, `revocation took ${elapsedMs}ms`);
    return { elapsedMs, storeEntries: store.size };
  },

  async "local-revocation-database"(context) {
    const { readPool, adminPool } = database(context);
    const limitMs = number(context, "withinMs");
    const search = () => readAs(readPool, "alice", "company-a", (client) => lexicalSearch(client, "company-a", ["source-a"], "manual", 10)).then((rows) => rows.map((row) => row.id)).catch(() => [] as string[]);
    await adminPool.query(`UPDATE public."user" SET active=true WHERE id='alice'`);
    assert((await search()).includes("chunk-doc-a"), "control read did not return the visible manual");
    try {
      await adminPool.query(`UPDATE public."user" SET active=false WHERE id='alice'`);
      const revokedAfterMs = await untilMs(async () => !(await search()).includes("chunk-doc-a"), limitMs);
      assert(revokedAfterMs <= limitMs, "canonical revocation did not stop reads in time");
      return { revokedAfterMs, scope: "local PostgreSQL read path; Google/Drive propagation measured separately" };
    } finally {
      await adminPool.query(`UPDATE public."user" SET active=true WHERE id='alice'`);
    }
  },

  async "freshness-and-deletion-database"(context) {
    const { readPool, adminPool } = database(context);
    const searchableMs = number(context, "searchableWithinMs");
    const deletionMs = number(context, "deletionWithinMs");
    const search = () => readAs(readPool, "alice", "company-a", (client) => lexicalSearch(client, "company-a", ["source-a"], freshFixture.term, 10)).then((rows) => rows.map((row) => row.documentId));
    await removeFreshFixture(adminPool);
    try {
      await adminPool.query(`INSERT INTO knowledge.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification) VALUES ($1,'company-a','alice','source-a',$1,'Fresh acceptance manual','alice','manual','published','internal')`, [freshFixture.documentId]);
      await adminPool.query(`INSERT INTO knowledge."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus") VALUES ($1,'company-a','alice',$2,'revision-1',repeat('f',64),'synthetic/fresh.pdf','1','application/pdf',100,now(),'parser-1','ready')`, [freshFixture.versionId, freshFixture.documentId]);
      await adminPool.query(`UPDATE knowledge.document SET "currentVersionId"=$2,version=version+1 WHERE "companyId"='company-a' AND id=$1`, [freshFixture.documentId, freshFixture.versionId]);
      await adminPool.query(`INSERT INTO knowledge."grant"(id,"companyId","createdBy","sourceId","documentId","subjectKind","subjectId",capability,origin,"policyVersion") VALUES ('acceptance_grant_local','company-a','alice','source-a',$1,'user','alice','read','local',1),('acceptance_grant_source','company-a','alice','source-a',$1,'user','alice','read','source',1)`, [freshFixture.documentId]);
      const extractionCompleted = performance.now();
      await adminPool.query(`INSERT INTO knowledge.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount","embeddingProfile","indexGeneration") VALUES ($1,'company-a','alice',$2,$3,0,$4,3,'lexical-v1',1)`, [freshFixture.chunkId, freshFixture.documentId, freshFixture.versionId, `${freshFixture.term} fresh acceptance manual`]);
      const searchableAfterMs = await untilMs(async () => (await search()).includes(freshFixture.documentId), searchableMs);
      const indexedTotalMs = performance.now() - extractionCompleted;
      assert(searchableAfterMs <= searchableMs, "new content did not become searchable in time");
      await adminPool.query(`UPDATE knowledge.document SET status='withdrawn',"deletedAt"=now(),"aclVersion"="aclVersion"+1,version=version+1 WHERE "companyId"='company-a' AND id=$1`, [freshFixture.documentId]);
      const deletedAfterMs = await untilMs(async () => !(await search()).includes(freshFixture.documentId), deletionMs);
      assert(deletedAfterMs <= deletionMs, "deleted content stayed searchable");
      await adminPool.query(`UPDATE knowledge.document SET status='published',"deletedAt"=NULL,version=version+1 WHERE "companyId"='company-a' AND id=$1`, [freshFixture.documentId]);
      await adminPool.query(`UPDATE knowledge."grant" SET "revokedAt"=now(),version=version+1 WHERE "companyId"='company-a' AND "documentId"=$1`, [freshFixture.documentId]);
      const revokedAfterMs = await untilMs(async () => !(await search()).includes(freshFixture.documentId), deletionMs);
      assert(revokedAfterMs <= deletionMs, "revoked local ACL stayed searchable");
      return { searchableAfterMs, indexedTotalMs, deletedAfterMs, revokedAfterMs, scope: "local PostgreSQL after extraction; parser latency measured by the browser gate" };
    } finally {
      await removeFreshFixture(adminPool);
    }
  },

  async "re-extraction-preserves-corrections"() {
    const reconciled = reconcileExtraction({ contractVersion: 1, fields: { partNumber: "MTR-10O" }, proposed: {}, evidence: {}, unresolved: [], warnings: ["ocr"] }, { contractVersion: 1, fields: { partNumber: "MTR-100-B", revision: "B" }, proposed: {}, evidence: { partNumber: [{ page: 1, text: "MTR-100-B" }] }, unresolved: [], warnings: [] }, { partNumber: { value: "MTR-100", decision: "corrected", evidence: ["p1"] } });
    assert(reconciled.fields.partNumber === "MTR-100" && reconciled.unresolved.includes("partNumber"), "re-extraction overwrote an accepted correction");
    assert(reconciled.fields.revision === "B" && reconciled.warnings.includes("ocr"), "re-extraction dropped new fields or prior warnings");
    const bytes = { kind: "object" as const, objectKey: "intake/manual.pdf", generation: "1", sha256: "a".repeat(64), mimeType: "application/pdf", bytes: 3 };
    const alpha = captureIdentity({ sourceId: "upload-alpha", ownerId: "usr_alex", acl: "internal", input: bytes });
    const beta = captureIdentity({ sourceId: "upload-beta", ownerId: "usr_blair", acl: "restricted", input: bytes });
    assert(alpha.idempotencyKey !== beta.idempotencyKey, "identical bytes merged two sources' ACLs");
    return { correctedField: reconciled.fields.partNumber, unresolved: reconciled.unresolved, separateIdentities: true };
  },

  async "intake-cannot-post-transactions-database"(context) {
    const { adminPool } = database(context);
    const outcomes: Record<string, string> = {};
    for (const role of ["knowledge_ingest", "knowledge_review"]) {
      outcomes[`${role}:mutator`] = await rolledBack(adminPool, role, "SELECT public.knowledge_fixture_mutator()");
      outcomes[`${role}:purchaseOrder`] = await rolledBack(adminPool, role, `INSERT INTO public."purchaseOrder" DEFAULT VALUES`);
    }
    assert(Object.values(outcomes).every((state) => state === "42501"), `intake roles reached business writes: ${JSON.stringify(outcomes)}`);
    return outcomes;
  },

  async "ticket-command-proposal"() {
    const payload = { boardId: "board:machine-build", initialColumnId: "column:pending", title: "Surface-grind the fixture plate", description: "", dueDate: "2026-09-30", businessTimezone: "UTC" };
    const proposal = { id: "cmd_synthetic", version: 1, action: "kanban.ticket.create" as const, target: { sourceId: "kanban", resourceId: "board:machine-build" }, payload, payloadHash: ticketCommandPayloadHash(payload), idempotencyKey: "cmp_alpha:usr_alex:kanban.ticket.create:synthetic" };
    const accepted = assertExecutableTicketCommand(proposal);
    const changed = (() => { try { assertExecutableTicketCommand({ ...proposal, payload: { ...payload, title: "Something else" } }); return "accepted"; } catch (error) { return (error as Error).message; } })();
    const unresolved = (() => { try { assertExecutableTicketCommand({ ...proposal, clarification: { field: "dueDate", choices: ["2026-09-30"] } }); return "accepted"; } catch (error) { return (error as Error).message; } })();
    assert(accepted.payload.initialColumnId === "column:pending", "resolved initial column changed");
    assert(/hash/.test(changed) && /clarification/.test(unresolved), "a changed or unresolved proposal was accepted");
    assert(ticketCommandPayloadHash({ b: 1, a: [2, { d: 1, c: 2 }] }) === ticketCommandPayloadHash({ a: [2, { c: 2, d: 1 }], b: 1 }), "idempotency hash depends on key order");
    return { accepted: accepted.id, changed, unresolved };
  },

  async "read-only-transport"() {
    let retrievals = 0;
    const command = await executeReadQuery({ ...locateRequest, text: "create a ticket to grind the bed", mode: "auto" }, principal, { retrieve: async () => { retrievals += 1; return []; }, authorize: async () => true });
    const purchase = routeQuery({ ...locateRequest, text: "schedule a purchase of 60x20 stators", mode: "auto" });
    assert(command.kind === "command" && retrievals === 0 && command.evidence.length === 0, "a command request executed retrieval or returned data");
    assert(purchase.kind === "command", "purchase intent routed as a read");
    assert(!queryRequestSchema.safeParse({ ...locateRequest, action: "kanban.ticket.create" }).success, "query contract accepted a mutation field");
    return { commandRoute: command.kind, retrievals, purchaseRoute: purchase.kind };
  },

  async "read-role-cannot-mutate-database"(context) {
    const { readPool, adminPool } = database(context);
    const readOnlyTransaction = await sqlState(readAs(readPool, "alice", "company-a", (client) => client.query("INSERT INTO knowledge.command DEFAULT VALUES")));
    const mutator = await rolledBack(adminPool, "knowledge_read", "SELECT public.knowledge_fixture_mutator()");
    const grant = await rolledBack(adminPool, "knowledge_read", `DELETE FROM knowledge."grant"`);
    assert(readOnlyTransaction !== "success" && mutator === "42501" && grant === "42501", `read transport reached a mutation: ${JSON.stringify({ readOnlyTransaction, mutator, grant })}`);
    return { readOnlyTransaction, mutator, grant };
  },

  async "connector-contract"() {
    const identity = { principal, companyGroupId: "group_alpha", allowedOperations: ["knowledge.query"], accessLevels: [], assurance: { mode: "carbon-mfa" as const } };
    const page = { items: [{ id: "part-1", type: "pcb", title: "Controller", revision: "B", fields: { status: "released" } }], observedAt: "2026-09-01T00:00:00Z", sourceRevision: "rev-7", status: "partial", incompleteReason: "source deleted two entities since the cursor", nextCursor: "cursor-2" };
    const registry = createSourceRegistry({ version: 1, sources: [{ id: "carbon", kind: "carbon", origin: "https://carbon.example.test/", audience: "carbon" }, { id: "kanban", kind: "kanban", origin: "https://kanban.example.test/", audience: "kanban" }, { id: "engineering", kind: "engineering", origin: "https://engineering.example.test/", audience: "engineering" }, { id: "crm", kind: "crm", origin: "https://crm.example.test/", audience: "crm" }] }, { request: new Request("https://query.example.test/"), identity, headers: async () => new Headers(), fetch: async (input) => { const path = new URL(String(input)).pathname; if (path === "/api/knowledge/access/check") return Response.json({ allowedIds: ["expanded"], policyVersion: "1", validUntil: "2026-09-01T00:00:00Z" }); return Response.json(page); } });
    const kinds = registry.list().map((source) => source.kind);
    const engineering = await registry.generic("engineering").searchEntities({ query: "controller", limit: 10 });
    const crm = await registry.generic("crm").searchEntities({ query: "controller", limit: 10, cursor: "cursor-1" });
    const narrowed = await registry.generic("crm").checkAccess(["part-1"]).then(() => "expanded", (error: Error) => error.message);
    assert(kinds.length === 4 && new Set(kinds).size === 4, "registry did not expose the four connector kinds");
    assert(engineering.nextCursor === "cursor-2" && engineering.sourceRevision === "rev-7" && engineering.status === "partial" && crm.incompleteReason?.includes("deleted"), "connector page lost pagination, version, freshness or deletion fields");
    assert(/expanded/.test(narrowed), "a connector widened the caller's access set");
    assert(!sourceRegistryConfigurationSchema.safeParse({ version: 1, sources: [{ id: "x", kind: "sharepoint", origin: "https://x.example.test/", audience: "x" }] }).success, "an unregistered connector kind was accepted");
    const before = routeQuery(locateRequest);
    assert(JSON.stringify(routeQuery(locateRequest)) === JSON.stringify(before) && before.kind === "locate", "router output depends on connector registration");
    return { kinds, engineeringStatus: engineering.status, narrowed };
  }
};
