import { createHash } from "node:crypto";
import { queryRequestSchema } from "@carbon/knowledge";
import {
  admitReadRequest,
  durableBudget
} from "@carbon/knowledge/budgets.server";
import { AuthorizedCache, type CacheStore } from "@carbon/knowledge/cache";
import { currentPolicySnapshot } from "@carbon/knowledge/cache/epochs.server";
import { withKnowledgeTransaction } from "@carbon/knowledge/database.server";
import { verifyWorkforceRequest } from "@carbon/knowledge/identity.server";
import { executeReadQuery, queryResultSchema } from "@carbon/knowledge/query";
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
import {
  assembleEvidence,
  providerEligible
} from "@carbon/knowledge/retrieval/evidence";
import { reciprocalRankFusion } from "@carbon/knowledge/retrieval/fusion";
import {
  chunkJoins,
  chunkProjection,
  lexicalSearch,
  type RetrievedChunk
} from "@carbon/knowledge/retrieval/lexical.server";
import { vectorSearch } from "@carbon/knowledge/retrieval/vector.server";
import type { SourceRegistryConfiguration } from "@carbon/knowledge/sources/registry.server";
import type { Pool } from "pg";
import { createDriveAccessChecker } from "./drive-access.server";
import { structuredSourceQuery } from "./sources.server";

type IdentityOptions = Omit<
  Parameters<typeof verifyWorkforceRequest>[0],
  "request" | "operation"
>;
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
      const currentIdentity = async () => {
        request.signal.throwIfAborted();
        const binding = await options.identityStore.resolveHuman({
          ...principal.sourceIdentity,
          companyId: principal.companyId
        });
        return binding &&
          binding.actorId === principal.actorId &&
          binding.bindingActive &&
          binding.userActive &&
          binding.membershipActive &&
          binding.capabilities.includes("knowledge.read")
          ? binding
          : null;
      };
      const policy = async () =>
        trace.measure("policy", async () => {
          const [snapshot, binding] = await Promise.all([
            read((client) => currentPolicySnapshot(client, sourceIds)),
            currentIdentity()
          ]);
          return {
            ...snapshot,
            allowed: snapshot.allowed && !!binding,
            policyVersion: `${snapshot.policyVersion}:${binding?.revocationVersion}:${binding?.permissionsVersion}`
          };
        });
      const authorizedChunks = async (ids: readonly string[]) =>
        read(
          async (client) =>
            (
              await client.query<RetrievedChunk>(
                `SELECT ${chunkProjection} FROM ${chunkJoins} WHERE c."companyId"=$1 AND c.id=ANY($2::text[])`,
                [principal.companyId, ids]
              )
            ).rows
        );
      const liveAccess = createDriveAccessChecker({
        request,
        identity,
        workerOrigin: options.workerOrigin,
        workerAudience: options.workerAudience
      });
      const authorizeIds = async (ids: string[]) => {
        if (!(await currentIdentity())) return false;
        const rows = await authorizedChunks(ids);
        return (
          rows.length === new Set(ids).size &&
          (await Promise.all(rows.map(liveAccess))).every(Boolean)
        );
      };
      const cache = new AuthorizedCache(options.cacheStore, policy);
      let computed = false;
      const result = await cache.get(
        {
          companyId: principal.companyId,
          actorId: principal.actorId,
          callerId: principal.callerId,
          capability: "knowledge.read",
          intent: query.mode,
          entities: [...sourceIds, query.context?.entityId ?? ""],
          query: query.text,
          locale: query.locale,
          businessTimezone: options.businessTimezone,
          modelVersion: options.model
            ? `${options.model.version}:${options.model.model}`
            : "locate-no-model",
          promptVersion: "query-v1",
          indexVersion: options.embedding?.version ?? "lexical-v1"
        },
        async () => {
          computed = true;
          trace.record("cache", "miss");
          const retrievedIds = new Set<string>();
          const providerIds = new Set<string>();
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
                          return read((client) =>
                            vectorSearch(
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
              for (const [index, chunk] of chunks.entries()) {
                if (live[index]) retrievedIds.add(chunk.id);
                else retrievalPartial = true;
                if (live[index] && providerEligible(chunk, "vertex"))
                  providerIds.add(chunk.id);
              }
              return assembleEvidence(chunks, {
                origin: options.origin,
                policyVersion: principal.policyVersion,
                maxTokens: 7000,
                countTokens: (text) => new TextEncoder().encode(text).length,
                authorize: async (chunk) => retrievedIds.has(chunk.id)
              });
            },
            authorize: async (evidence) => retrievedIds.has(evidence.id),
            ...(answer
              ? {
                  synthesize: async (input, evidence, signal) => {
                    const permitted = evidence.filter((item) =>
                      providerIds.has(item.id)
                    );
                    if (!permitted.length) return { claims: [] };
                    if (!(await authorizeIds(permitted.map((item) => item.id))))
                      throw Error("Authorization changed");
                    return trace.measure("model", () =>
                      answer(input, permitted, signal)
                    );
                  }
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
