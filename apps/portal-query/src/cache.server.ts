import type { QueryRequest } from "@carbon/portal";
import {
  AuthorizedCache,
  type CacheScope,
  type CacheStore,
  type PolicySnapshot
} from "@carbon/portal/cache";
import { currentPolicySnapshot } from "@carbon/portal/cache/epochs.server";
import type { withPortalTransaction } from "@carbon/portal/database.server";
import type {
  IdentityBinding,
  WorkforceIdentityStore
} from "@carbon/portal/identity.server";
import type { EmbeddingConfiguration } from "@carbon/portal/query/embedding.server";
import type { VertexConfiguration } from "@carbon/portal/query/vertex.server";
import {
  chunkJoins,
  chunkProjection,
  type RetrievedChunk
} from "@carbon/portal/retrieval/lexical.server";
import type { Telemetry } from "@carbon/portal/telemetry";

export type HumanReadPrincipal = {
  companyId: string;
  actorId: string;
  callerId: string;
  sourceIdentity: { issuer: string; subject: string };
};

export type ReadTransaction = <T>(
  operation: Parameters<typeof withPortalTransaction<T>>[3]
) => Promise<T>;

/**
 * Every field that may change what a cached answer contains is part of the
 * key; the policy version and source epochs join it at lookup time.
 */
export function queryCacheScope(options: {
  principal: Pick<HumanReadPrincipal, "companyId" | "actorId" | "callerId">;
  query: QueryRequest;
  sourceIds: readonly string[];
  /** Restored follow-up context; a question asked in context is a different question. */
  conversationEvidenceIds?: readonly string[];
  businessTimezone: string;
  model?: VertexConfiguration;
  embedding?: EmbeddingConfiguration;
}): CacheScope {
  return {
    companyId: options.principal.companyId,
    actorId: options.principal.actorId,
    callerId: options.principal.callerId,
    capability: "portal.read",
    intent: options.query.mode,
    entities: [
      ...options.sourceIds,
      options.query.context?.entityId ?? "",
      ...(options.conversationEvidenceIds ?? []).map(
        (id) => `conversation:${id}`
      )
    ],
    query: options.query.text,
    locale: options.query.locale,
    businessTimezone: options.businessTimezone,
    modelVersion: options.model
      ? `${options.model.version}:${options.model.model}`
      : "locate-no-model",
    promptVersion: "query-v1",
    indexVersion: options.embedding?.version ?? "lexical-v1"
  };
}

/**
 * The authorization surface a cached read is checked against, wired to the
 * authoritative stores for one request. Policy is the source epochs plus the
 * actor's live binding; evidence is re-read under the actor's row policy and
 * the source's live access check before any cached value is delivered.
 */
export function createReadAuthorization(options: {
  read: ReadTransaction;
  principal: HumanReadPrincipal;
  identityStore: WorkforceIdentityStore;
  sourceIds: readonly string[];
  signal: AbortSignal;
  trace: Pick<Telemetry, "measure">;
  liveAccess: (chunk: RetrievedChunk) => Promise<boolean>;
}) {
  const { principal, read, sourceIds } = options;
  const currentIdentity = async (): Promise<IdentityBinding | null> => {
    options.signal.throwIfAborted();
    const binding = await options.identityStore.resolveHuman({
      ...principal.sourceIdentity,
      companyId: principal.companyId
    });
    return binding &&
      binding.actorId === principal.actorId &&
      binding.bindingActive &&
      binding.userActive &&
      binding.membershipActive &&
      binding.capabilities.includes("portal.read")
      ? binding
      : null;
  };
  const policy = async (): Promise<PolicySnapshot> =>
    options.trace.measure("policy", async () => {
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
  const authorizedCandidates = async (ids: readonly string[]) => {
    if (!(await currentIdentity())) return null;
    const rows = await authorizedChunks(ids);
    return rows.length === new Set(ids).size &&
      (await Promise.all(rows.map(options.liveAccess))).every(Boolean)
      ? rows
      : null;
  };
  const authorizeIds = async (ids: readonly string[]) =>
    !!(await authorizedCandidates(ids));
  return { currentIdentity, policy, authorizedCandidates, authorizeIds };
}

export function createQueryCache(
  store: CacheStore,
  policy: () => Promise<PolicySnapshot>
) {
  return new AuthorizedCache(store, policy);
}
