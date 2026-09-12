import { createHash } from "node:crypto";
import {
  type Evidence,
  type QueryRequest,
  queryRequestSchema
} from "@carbon/knowledge";
import {
  admitReadRequest,
  durableBudget
} from "@carbon/knowledge/budgets.server";
import type { CacheStore } from "@carbon/knowledge/cache";
import { withKnowledgeTransaction } from "@carbon/knowledge/database.server";
import { verifyWorkforceRequest } from "@carbon/knowledge/identity.server";
import { assertProviderCandidates } from "@carbon/knowledge/provider-policy";
import {
  executeReadQuery,
  queryResultSchema,
  type ReadDependencies
} from "@carbon/knowledge/query";
import {
  createVertexEmbedder,
  type EmbeddingConfiguration
} from "@carbon/knowledge/query/embedding.server";
import { requestTelemetry } from "@carbon/knowledge/query/request-boundary.server";
import { routeQuery } from "@carbon/knowledge/query/router";
import {
  createVertexAnswerProvider,
  type VertexConfiguration
} from "@carbon/knowledge/query/vertex.server";
import { assembleEvidence } from "@carbon/knowledge/retrieval/evidence";
import { reciprocalRankFusion } from "@carbon/knowledge/retrieval/fusion";
import {
  lexicalSearch,
  type RetrievedChunk
} from "@carbon/knowledge/retrieval/lexical.server";
import { loadParentSections } from "@carbon/knowledge/retrieval/sections.server";
import { vectorSearchApproximate } from "@carbon/knowledge/retrieval/vector.server";
import type { SourceRegistryConfiguration } from "@carbon/knowledge/sources/registry.server";
import type { Telemetry } from "@carbon/knowledge/telemetry";
import type { Pool } from "pg";
import {
  createQueryCache,
  createReadAuthorization,
  queryCacheScope
} from "./cache.server";
import { createDriveAccessChecker } from "./drive-access.server";
import { structuredSourceQuery } from "./sources.server";

type IdentityOptions = Omit<
  Parameters<typeof verifyWorkforceRequest>[0],
  "request" | "operation"
>;

/**
 * The only path from evidence to an answer provider. The candidates are re-read
 * under the reader's current authorization first, then their source policy is
 * checked as a whole: one ineligible member refuses the call (recorded as a
 * `model` deny) instead of trimming the set the provider sees.
 */
export function createProviderDisclosure(options: {
  providerId: string;
  trace: Pick<Telemetry, "record" | "measure">;
  authorizedCandidates: (
    ids: readonly string[]
  ) => Promise<readonly RetrievedChunk[] | null>;
  answer: (
    request: QueryRequest,
    evidence: Evidence[],
    signal: AbortSignal
  ) => Promise<unknown>;
}): NonNullable<ReadDependencies["synthesize"]> {
  return async (request, evidence, signal) => {
    const candidates = await options.authorizedCandidates(
      evidence.map((item) => item.id)
    );
    if (!candidates) throw Error("Authorization changed");
    try {
      assertProviderCandidates(options.providerId, candidates);
    } catch (error) {
      options.trace.record("model", "deny");
      throw error;
    }
    return options.trace.measure("model", () =>
      options.answer(request, evidence, signal)
    );
  };
}
export function createReadHandler(
  options: IdentityOptions & {
    pool: Pool;
    origin: string;
    cacheStore: CacheStore;
    businessTimezone: string;
    model?: VertexConfiguration;
    sources?: SourceRegistryConfiguration;
    embedding?: EmbeddingConfiguration;
    workerOrigin?: string;
    workerAudience?: string;
    manualSourceId?: string;
    /** Loopback harness seam only; production mints the forwarded token. */
    driveForwardingHeaders?: Parameters<
      typeof createDriveAccessChecker
    >[0]["forwardingHeaders"];
  }
) {
  return async (request: Request): Promise<Response> => {
    const trace = requestTelemetry(request, "query");
    try {
      const identity = await trace.measure("authentication", () =>
        verifyWorkforceRequest({
          ...options,
          request,
          operation: "knowledge.query"
        })
      );
      request.signal.throwIfAborted();
      const principal = identity.principal;
      if (!principal.capabilities.includes("knowledge.read"))
        return Response.json({ error: "forbidden" }, { status: 403 });
      const parsed = queryRequestSchema.safeParse(await request.json());
      if (!parsed.success)
        return Response.json({ error: "invalid_query" }, { status: 422 });
      if (
        options.manualSourceId &&
        parsed.data.context?.source &&
        parsed.data.context.source !== options.manualSourceId
      )
        return Response.json({ error: "source_unavailable" }, { status: 403 });
      if (options.manualSourceId && routeQuery(parsed.data).kind === "command")
        return Response.json(
          { error: "manual_library_is_read_only" },
          { status: 403 }
        );
      const query = options.manualSourceId
        ? {
            ...parsed.data,
            mode: "locate" as const,
            context: { source: options.manualSourceId }
          }
        : parsed.data;
      if (
        !(await trace.measure("policy", () =>
          admitReadRequest(options.pool, principal, "knowledge.query")
        ))
      )
        return Response.json(
          { error: "request_limit_exceeded" },
          {
            status: 429,
            headers: { "cache-control": "no-store", "retry-after": "60" }
          }
        );
      if (routeQuery(query).kind === "command")
        return Response.json(
          await executeReadQuery(query, principal, {
            retrieve: async () => [],
            authorize: async () => false
          }),
          { headers: { "cache-control": "no-store" } }
        );
      if (options.sources && !options.manualSourceId) {
        const sourceConfiguration = options.sources;
        const structured = await trace.measure("source", () =>
          structuredSourceQuery({
            request,
            query,
            identity,
            pool: options.pool,
            configuration: sourceConfiguration,
            origin: options.origin,
            workerOrigin: options.workerOrigin,
            workerAudience: options.workerAudience
          })
        );
        if (structured) {
          const current = await options.identityStore.resolveHuman({
            ...principal.sourceIdentity,
            companyId: principal.companyId
          });
          if (
            !current?.bindingActive ||
            !current.userActive ||
            !current.membershipActive ||
            current.actorId !== principal.actorId ||
            !current.capabilities.includes("knowledge.read")
          )
            throw Error("Authorization changed");
          return Response.json(queryResultSchema.parse(structured), {
            headers: { "cache-control": "no-store" }
          });
        }
      }
      const read = <T>(
        operation: Parameters<typeof withKnowledgeTransaction<T>>[3]
      ) => {
        request.signal.throwIfAborted();
        return withKnowledgeTransaction(
          options.pool,
          principal,
          "read",
          operation
        );
      };
      const sourceRows = await read(
        async (client) =>
          (
            await client.query<{ id: string }>(
              `SELECT id FROM knowledge.source WHERE "companyId"=$1 AND status='active' AND ($2::text IS NULL OR id=$2) AND ($3::boolean=false OR kind='upload') ORDER BY id LIMIT 5`,
              [
                principal.companyId,
                query.context?.source ?? null,
                !!options.manualSourceId
              ]
            )
          ).rows
      );
      const sourceIds = sourceRows.slice(0, 4).map((source) => source.id);
      if (!sourceIds.length)
        return Response.json({
          requestId: query.requestId,
          kind: "abstention",
          evidence: [],
          claims: [],
          message: "No authorized sources are available.",
          partial: false
        });
      const liveAccess = createDriveAccessChecker({
        request,
        identity,
        workerOrigin: options.workerOrigin,
        workerAudience: options.workerAudience,
        forwardingHeaders: options.driveForwardingHeaders
      });
      const { policy, authorizedCandidates, authorizeIds } =
        createReadAuthorization({
          read,
          principal,
          identityStore: options.identityStore,
          sourceIds,
          signal: request.signal,
          trace,
          liveAccess
        });
      const cache = createQueryCache(options.cacheStore, policy);
      let computed = false;
      const result = await cache.get(
        queryCacheScope({
          principal,
          query,
          sourceIds,
          businessTimezone: options.businessTimezone,
          model: options.model,
          embedding: options.embedding
        }),
        async () => {
          computed = true;
          trace.record("cache", "miss");
          const retrievedIds = new Set<string>();
          let retrievalPartial = false;
          const embed =
            !options.manualSourceId && options.embedding
              ? createVertexEmbedder(options.embedding, {
                  budget: durableBudget(options.pool, principal)
                })
              : undefined;
          const answer =
            !options.manualSourceId && options.model
              ? createVertexAnswerProvider(options.model, {
                  budget: durableBudget(options.pool, principal)
                })
              : undefined;
          const result = await executeReadQuery(query, principal, {
            signal: request.signal,
            retrieve: async (text, signal) => {
              if (signal.aborted) throw Error("Query canceled");
              const semantic = embed && routeQuery(query).kind !== "locate";
              const rankings = await trace.measure("retrieval", () =>
                Promise.allSettled([
                  read((client) =>
                    lexicalSearch(
                      client,
                      principal.companyId,
                      sourceIds,
                      text,
                      semantic ? 20 : 40
                    )
                  ),
                  ...(semantic
                    ? [
                        (async () => {
                          const vector = await embed({
                            text,
                            requestId: createHash("sha256")
                              .update(`${query.requestId}:embedding`)
                              .digest("hex"),
                            task: "RETRIEVAL_QUERY",
                            signal: AbortSignal.any([
                              signal,
                              AbortSignal.timeout(900)
                            ])
                          });
                          // The database picks the index or the exact path
                          // and reports it on every row (see retrieval/recall.ts).
                          return read((client) =>
                            vectorSearchApproximate(
                              client,
                              principal.companyId,
                              sourceIds,
                              vector.embedding,
                              vector.profile,
                              20
                            )
                          );
                        })()
                      ]
                    : [])
                ])
              );
              const permittedRankings: RetrievedChunk[][] = [];
              for (const ranking of rankings) {
                if (ranking.status === "fulfilled")
                  permittedRankings.push(ranking.value);
                else retrievalPartial = true;
              }
              const chunks = reciprocalRankFusion(permittedRankings, 8);
              const live = await Promise.all(chunks.map(liveAccess));
              const denied = new Set<string>();
              for (const [index, chunk] of chunks.entries()) {
                if (live[index]) retrievedIds.add(chunk.id);
                else {
                  denied.add(chunk.id);
                  retrievalPartial = true;
                }
              }
              return assembleEvidence(chunks, {
                origin: options.origin,
                policyVersion: principal.policyVersion,
                maxTokens: 7000,
                countTokens: (text) => new TextEncoder().encode(text).length,
                // Selected chunks were checked above; a parent section is
                // checked live the same way before it is delivered.
                authorize: async (chunk) => {
                  if (retrievedIds.has(chunk.id)) return true;
                  if (denied.has(chunk.id) || !(await liveAccess(chunk)))
                    return false;
                  retrievedIds.add(chunk.id);
                  return true;
                },
                expandSections: (selected) =>
                  read((client) =>
                    loadParentSections(client, principal.companyId, selected)
                  )
              });
            },
            authorize: async (evidence) => retrievedIds.has(evidence.id),
            ...(answer
              ? {
                  synthesize: createProviderDisclosure({
                    providerId: "vertex",
                    trace,
                    authorizedCandidates,
                    answer
                  })
                }
              : {})
          });
          result.partial = sourceRows.length > 4 || retrievalPartial;
          return {
            value: result,
            evidenceIds: result.evidence.map((item) => item.id),
            cacheable: !result.partial
          };
        },
        (value) => queryResultSchema.parse(value),
        authorizeIds
      );
      if (!computed) trace.record("cache", "hit");
      // Request IDs are delivery metadata, never another request's cached ID.
      return Response.json(
        { ...result, requestId: query.requestId },
        { headers: { "cache-control": "no-store" } }
      );
    } catch {
      return Response.json(
        { error: "query_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } }
      );
    }
  };
}
