import type { VerifiedWorkforceIdentity } from "@carbon/knowledge/identity.server";

import { executeTicketCommand } from "./ticket";

export type TicketActionDependencies = {
  verifyWorkforce: (request: Request) => Promise<VerifiedWorkforceIdentity>;
  forwardingHeaders: (
    request: Request,
    identity: VerifiedWorkforceIdentity
  ) => Promise<Headers>;
  sourceId: string;
  sourceUrl: string;
  fetchImpl?: typeof fetch;
};

export async function handleTicketCommand(
  request: Request,
  dependencies: TicketActionDependencies
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  let command: unknown;
  try {
    command = await request.json();
  } catch {
    return new Response("A JSON command proposal is required", { status: 400 });
  }
  try {
    const identity = await dependencies.verifyWorkforce(request);
    const headers = await dependencies.forwardingHeaders(request, identity);
    const result = await executeTicketCommand({
      command,
      principal: identity.principal,
      sourceId: dependencies.sourceId,
      sourceUrl: dependencies.sourceUrl,
      forwardHeaders: headers,
      fetchImpl: dependencies.fetchImpl
    });
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  } catch {
    // Authentication/verifier details and bearer assertions never leave this edge.
    return new Response(
      "Ticket command was not authorized or could not be completed",
      { status: 403 }
    );
  }
}
