import { currentInstant } from "@carbon/knowledge/commands/procurement";
import type { VerifiedWorkforceIdentity } from "@carbon/knowledge/identity.server";
import { executeProcurementDraftCommand } from "./procurement";

export type ProcurementActionDependencies = {
  verifyWorkforce: (request: Request) => Promise<VerifiedWorkforceIdentity>;
  forwardingHeaders: (
    request: Request,
    identity: VerifiedWorkforceIdentity
  ) => Promise<Headers>;
  sourceUrl: string;
  fetchImpl?: typeof fetch;
  /** Injectable so a test pins date resolution without freezing the clock. */
  now?: () => string;
};

export async function handleProcurementCommand(
  request: Request,
  dependencies: ProcurementActionDependencies
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let command: unknown;
  try {
    command = await request.json();
  } catch {
    return new Response("A JSON command proposal is required", { status: 400 });
  }
  try {
    const identity = await dependencies.verifyWorkforce(request);
    const headers = await dependencies.forwardingHeaders(request, identity);
    const result = await executeProcurementDraftCommand({
      command,
      principal: identity.principal,
      sourceUrl: dependencies.sourceUrl,
      forwardHeaders: headers,
      fetchImpl: dependencies.fetchImpl,
      now: (dependencies.now ?? currentInstant)()
    });
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  } catch {
    // Authentication/verifier details and bearer assertions never leave this edge.
    return new Response(
      "Procurement command was not authorized or could not be completed",
      { status: 403 }
    );
  }
}
