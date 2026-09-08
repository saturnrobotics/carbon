import { z } from "zod";
import {
  type Evidence,
  evidenceSchema,
  type Principal,
  type QueryRequest,
  queryRequestSchema
} from "../contracts";
import { withDeadline } from "./deadline.server";
import { routeQuery } from "./router";

export const claimSchema = z
  .object({
    text: z.string().min(1).max(2000),
    evidenceIds: z.array(z.string().min(1).max(256)).min(1).max(8)
  })
  .strict();
export const synthesisSchema = z
  .object({ claims: z.array(claimSchema).max(12) })
  .strict();
export const queryResultSchema = z
  .object({
    requestId: z.string(),
    kind: z.enum([
      "results",
      "answer",
      "abstention",
      "command",
      "clarification"
    ]),
    evidence: z.array(evidenceSchema).max(8),
    claims: z.array(claimSchema).max(12),
    message: z.string().max(500),
    partial: z.boolean(),
    choices: z
      .array(
        z
          .object({ id: z.string().max(256), label: z.string().max(500) })
          .strict()
      )
      .max(20)
      .optional()
  })
  .strict();
export type QueryResult = z.infer<typeof queryResultSchema>;
export type ReadDependencies = {
  signal?: AbortSignal;
  retrieve: (text: string, signal: AbortSignal) => Promise<Evidence[]>;
  authorize: (evidence: Evidence) => Promise<boolean>;
  synthesize?: (
    request: QueryRequest,
    evidence: Evidence[],
    signal: AbortSignal
  ) => Promise<unknown>;
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
  const result: QueryResult = {
    requestId: request.requestId,
    kind: "abstention",
    evidence: [],
    claims: [],
    message: "No authorized evidence was found.",
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
    10000,
    async (signal) => {
      const candidates = await dependencies.retrieve(route.searchText, signal);
      if (candidates.length > 8) throw Error("Evidence budget exceeded");
      for (const candidate of candidates) {
        const evidence = evidenceSchema.parse(candidate);
        if (await dependencies.authorize(evidence))
          result.evidence.push(evidence);
      }
      if (signal.aborted) throw Error("Query deadline exceeded");
      if (!result.evidence.length) return result;
      result.kind = "results";
      result.message = "";
      if (route.kind === "read" && dependencies.synthesize) {
        const parsed = synthesisSchema.safeParse(
          await dependencies.synthesize(request, result.evidence, signal)
        );
        const ids = new Set(result.evidence.map((item) => item.id));
        if (
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
          result.message =
            "The available evidence did not support a verified answer.";
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
