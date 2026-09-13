import {
  type Evidence,
  evidenceSchema,
  type Principal,
  type QueryRequest,
  queryRequestSchema
} from "../contracts";
import { ProviderPolicyRefusal } from "../provider-policy";
import { QUERY_BUDGETS } from "./budgets";
import { withDeadline } from "./deadline.server";
import { type QueryResult, queryResultSchema, synthesisSchema } from "./result";
import { QUERY_CAPABILITIES, routeQuery } from "./router";
import type { QueryStreamEvent } from "./stream";

export {
  claimSchema,
  type QueryClaim,
  type QueryResult,
  queryResultSchema,
  synthesisSchema
} from "./result";

export const PROVIDER_POLICY_REFUSED_MESSAGE =
  "An answer was not generated because the evidence includes a source that is not admitted to the answer provider.";
export const UNSUPPORTED_ANSWER_MESSAGE =
  "The available evidence did not support a verified answer.";
export const NO_EVIDENCE_MESSAGE = "No authorized evidence was found.";

export type ReadDependencies = {
  signal?: AbortSignal;
  retrieve: (text: string, signal: AbortSignal) => Promise<Evidence[]>;
  authorize: (evidence: Evidence) => Promise<boolean>;
  synthesize?: (
    request: QueryRequest,
    evidence: Evidence[],
    signal: AbortSignal
  ) => Promise<unknown>;
  /**
   * Observes the read as it happens. Authorized evidence is reported once,
   * before any synthesis; a synthesis stage is reported only when a model
   * call really starts. The terminal result is the function's return value,
   * so an observer never sees anything the caller would not.
   */
  emit?: (event: QueryStreamEvent) => void;
};

export async function executeReadQuery(
  input: QueryRequest,
  principal: Principal,
  dependencies: ReadDependencies
): Promise<QueryResult> {
  const request = queryRequestSchema.parse(input);
  if (
    principal.kind !== "human" ||
    !principal.capabilities.includes("knowledge.read")
  )
    throw Error("Access denied");
  const route = routeQuery(request);
  const capability = QUERY_CAPABILITIES[route.capability];
  const emit = dependencies.emit ?? (() => undefined);
  const result: QueryResult = {
    requestId: request.requestId,
    kind: "abstention",
    evidence: [],
    claims: [],
    message: NO_EVIDENCE_MESSAGE,
    partial: false
  };
  if (route.kind === "command")
    return {
      ...result,
      kind: "command",
      message:
        "This request requires a permitted command. Review its resolved target and details."
    };
  return withDeadline(
    QUERY_BUDGETS.requestDeadlineMs,
    async (signal) => {
      emit({ type: "progress", stage: "retrieval", state: "started" });
      const candidates = await dependencies.retrieve(route.searchText, signal);
      if (candidates.length > QUERY_BUDGETS.evidenceBlocks)
        throw Error("Evidence budget exceeded");
      for (const candidate of candidates) {
        const evidence = evidenceSchema.parse(candidate);
        if (await dependencies.authorize(evidence))
          result.evidence.push(evidence);
      }
      if (signal.aborted) throw Error("Query deadline exceeded");
      if (!result.evidence.length) return result;
      result.kind = "results";
      result.message = "";
      // Evidence is delivered the moment it is authorized: a locate answer is
      // complete here, and a read answer's evidence precedes its claims.
      emit({ type: "evidence", evidence: [...result.evidence] });
      // The locate capability admits no inference at all; only a capability
      // registered with `inference: "answer"` may reach a provider, and then
      // exactly once.
      if (capability.inference === "answer" && dependencies.synthesize) {
        emit({ type: "progress", stage: "synthesis", state: "started" });
        let synthesized: unknown;
        let refused = false;
        try {
          synthesized = await dependencies.synthesize(
            request,
            result.evidence,
            signal
          );
        } catch (error) {
          if (!(error instanceof ProviderPolicyRefusal)) throw error;
          // Refused whole, never trimmed: the reader keeps the evidence and no
          // provider saw any of it.
          refused = true;
        }
        const parsed = synthesisSchema.safeParse(synthesized);
        const ids = new Set(result.evidence.map((item) => item.id));
        if (refused) {
          result.message = PROVIDER_POLICY_REFUSED_MESSAGE;
        } else if (
          parsed.success &&
          parsed.data.claims.length &&
          parsed.data.claims.every((claim) =>
            claim.evidenceIds.every((id) => ids.has(id))
          )
        ) {
          result.kind = "answer";
          result.claims = parsed.data.claims;
        } else {
          result.kind = "abstention";
          result.message = UNSUPPORTED_ANSWER_MESSAGE;
        }
      }
      if (signal.aborted) throw Error("Query deadline exceeded");
      const authorized = await Promise.all(
        result.evidence.map((item) => dependencies.authorize(item))
      );
      if (authorized.some((allowed) => !allowed))
        throw Error("Authorization changed");
      return queryResultSchema.parse(result);
    },
    dependencies.signal
  );
}
