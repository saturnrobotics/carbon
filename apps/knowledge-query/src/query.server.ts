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
  type QueryResult,
  queryResultSchema,
  type ReadDependencies
} from "@carbon/knowledge/query";
import {
  conservativeTokenCount,
  QUERY_BUDGETS
} from "@carbon/knowledge/query/budgets";
import type { ConversationState } from "@carbon/knowledge/query/conversation";
import {
  createVertexEmbedder,
  type EmbeddingConfiguration
} from "@carbon/knowledge/query/embedding.server";
import { requestTelemetry } from "@carbon/knowledge/query/request-boundary.server";
import { routeQuery } from "@carbon/knowledge/query/router";
import {
  acceptsQueryStream,
  encodeQueryStreamEvent,
  QUERY_STREAM_MEDIA_TYPE,
  type QueryStreamEvent
} from "@carbon/knowledge/query/stream";
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
import {
  StepUpRequiredError,
  stepUpRequiredResponse
} from "@carbon/knowledge/step-up";
import type { Telemetry } from "@carbon/knowledge/telemetry";
import type { Pool } from "pg";
import {
  createQueryCache,
  createReadAuthorization,
  queryCacheScope
} from "./cache.server";
import type { ConversationStore } from "./conversation.server";
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

/** Maps a failure inside a started stream to the only codes the reader sees. */
export function streamErrorCode(error: unknown): QueryStreamEvent & {
  type: "error";
} {
  const message = error instanceof Error ? error.message : "";
  if (/Authorization changed|Access denied/.test(message))
    return { type: "error", error: "authorization_changed" };
  if (/deadline exceeded/i.test(message))
    return { type: "error", error: "request_deadline_exceeded" };
  return { type: "error", error: "query_unavailable" };
}

/**
 * Delivers a read either as one JSON document or, when the caller accepts
 * NDJSON, as the events the read produces while it runs. A stream carries the
 * same terminal result a JSON response would; a failure after the first event
 * is reported as an error event rather than a status the reader cannot see.
 */
export function respondWithQuery(
  streaming: boolean,
  compute: (emit: (event: QueryStreamEvent) => void) => Promise<QueryResult>
): Promise<Response> | Response {
  const headers = { "cache-control": "no-store" };
  if (!streaming)
    return compute(() => undefined).then((result) =>
      Response.json(result, { headers })
    );
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: QueryStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeQueryStreamEvent(event)));
        } catch {
          open = false;
        }
      };
      try {
        const result = await compute(emit);
        emit({ type: "result", result });
      } catch (error) {
        emit(streamErrorCode(error));
      } finally {
        open = false;
        controller.close();
      }
    }
  });
  return new Response(body, {
    status: 200,
    headers: { ...headers, "content-type": QUERY_STREAM_MEDIA_TYPE }
  });
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
    /** Follow-up context between requests; absent means every question stands alone. */
    conversationStore?: ConversationStore;
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
      // Routing is decided once, from the request text alone, before any
      // admission, source or index work.
      if (options.manualSourceId && routeQuery(parsed.data).kind === "command")
        return Response.json(
          { error: "manual_library_is_read_only" },
          { status: 403 }
        );
      const query = options.manualSourceId
        ? {
            ...parsed.data,
            mode: "locate" as const,
            context: {
              source: options.manualSourceId,
              ...(parsed.data.context?.conversationId
                ? { conversationId: parsed.data.context.conversationId }
                : {})
            }
          }
        : parsed.data;
      const route = routeQuery(query);
      const streaming = acceptsQueryStream(request);
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
      if (route.kind === "command")
        return respondWithQuery(streaming, () =>
          executeReadQuery(query, principal, {
            retrieve: async () => [],
            authorize: async () => false
          })
        );
      // A registered live source answers before any index or model. It runs
      // outside the stream so a source's step-up denial keeps its own status.
      //
      // The condition is the registry and the router's decision, and nothing
      // else. It used to also require the ABSENCE of a manual source, which
      // made the released profile's behaviour an accident of a second setting:
      // the manual source is required configuration there, so a registered
      // Carbon source could never be reached however it was configured. The
      // two coexist, with the manual library primary — a registered source
      // answers only the structured intents the router names, and every other
      // question, and every structured one no registered source answers, still
      // falls through to the manual index below.
      if (options.sources && route.structured) {
        const sourceConfiguration = options.sources;
        const structured = await trace.measure("source", () =>
          structuredSourceQuery({
            request,
            // The reader's own request, not the manual-pinned rewrite above:
            // that pin confines the DOCUMENT index read to the upload library,
            // and a live source is not in it. Pinning it here would leave every
            // registered source unpermitted, which is the same unreachability
            // under a different name. `route` still applies unchanged — the
            // router reads the request TEXT, which the rewrite never touches.
            query: parsed.data,
            route,
            identity,
            pool: options.pool,
            configuration: sourceConfiguration,
            origin: options.origin,
            businessTimezone: options.businessTimezone,
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
          const result = queryResultSchema.parse(structured);
          return respondWithQuery(streaming, async () => result);
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
      const sourceLimit = QUERY_BUDGETS.sourcesPerRequest;
      const sourceRows = await read(
        async (client) =>
          (
            await client.query<{ id: string }>(
              `SELECT id FROM knowledge.source WHERE "companyId"=$1 AND status='active' AND ($2::text IS NULL OR id=$2) AND ($3::boolean=false OR kind='upload') ORDER BY id LIMIT $4`,
              [
                principal.companyId,
                query.context?.source ?? null,
                !!options.manualSourceId,
                sourceLimit + 1
              ]
            )
          ).rows
      );
      const sourceIds = sourceRows
        .slice(0, sourceLimit)
        .map((source) => source.id);
      if (!sourceIds.length)
        return respondWithQuery(streaming, async () => ({
          requestId: query.requestId,
          kind: "abstention",
          evidence: [],
          claims: [],
          message: "No authorized sources are available.",
          partial: false
        }));
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
      // Follow-up context is restored whole or not at all, and only after
      // every referenced evidence id passes the same check a cached result
      // must pass. A missing or refused context starts the question afresh.
      const conversationId = query.context?.conversationId;
      const conversation: ConversationState | null =
        conversationId && options.conversationStore
          ? await options.conversationStore.load(
              principal,
              conversationId,
              authorizeIds
            )
          : null;
      const cache = createQueryCache(options.cacheStore, policy);
      return respondWithQuery(streaming, async (emit) => {
        let computed = false;
        const result = await cache.get(
          queryCacheScope({
            principal,
            query,
            sourceIds,
            conversationEvidenceIds: conversation?.evidenceIds ?? [],
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
              emit,
              retrieve: async (text, signal) => {
                if (signal.aborted) throw Error("Query canceled");
                const semantic = embed && route.kind !== "locate";
                const rankings = await trace.measure("retrieval", () =>
                  Promise.allSettled([
                    read((client) =>
                      lexicalSearch(
                        client,
                        principal.companyId,
                        sourceIds,
                        text,
                        semantic ? 20 : QUERY_BUDGETS.candidatesPerSource
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
                if (retrievalPartial)
                  emit({
                    type: "progress",
                    stage: "retrieval",
                    state: "partial"
                  });
                // What the reader was last shown stays a candidate for the
                // follow-up, re-read under current authorization, ranked
                // alongside the fresh hits rather than replacing them.
                if (conversation?.evidenceIds.length) {
                  const prior = await authorizedCandidates(
                    conversation.evidenceIds
                  );
                  if (prior) permittedRankings.push([...prior]);
                }
                const chunks = reciprocalRankFusion(
                  permittedRankings,
                  QUERY_BUDGETS.evidenceBlocks
                );
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
                  maxTokens: QUERY_BUDGETS.evidenceTokens,
                  countTokens: conservativeTokenCount,
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
            result.partial =
              sourceRows.length > sourceLimit || retrievalPartial;
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
        if (
          conversationId &&
          options.conversationStore &&
          result.evidence.length
        )
          await options.conversationStore.save(
            principal,
            conversationId,
            result.evidence.map((item) => item.id)
          );
        // Request IDs are delivery metadata, never another request's cached ID.
        return { ...result, requestId: query.requestId };
      });
    } catch (error) {
      // A source that requires Carbon MFA is the one failure the portal must
      // be able to name; everything else stays an opaque unavailability.
      if (error instanceof StepUpRequiredError) return stepUpRequiredResponse();
      return Response.json(
        { error: "query_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } }
      );
    }
  };
}
