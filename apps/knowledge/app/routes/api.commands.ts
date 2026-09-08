import { assertExecutableTicketCommandBrowser } from "@carbon/knowledge/commands/ticket.browser";
import type { VerifiedIapBrowserRequest } from "@carbon/knowledge/identity.server";
import {
  forwardVerifiedWorkforceRequest,
  verifyKnowledgeBrowserRequest
} from "../services/identity.server";

export type CommandGatewayDependencies = {
  verifyWorkforce: (request: Request) => Promise<VerifiedIapBrowserRequest>;
  forwardingHeaders: (
    request: Request,
    identity: VerifiedIapBrowserRequest
  ) => Promise<Headers>;
  actionsUrl: string;
  fetchImpl?: typeof fetch;
};

export async function forwardTicketCommand(
  request: Request,
  dependencies: CommandGatewayDependencies
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    return new Response("Invalid ticket command request", { status: 403 });
  let proposal: unknown;
  try {
    proposal = await request.json();
    await assertExecutableTicketCommandBrowser(proposal);
  } catch {
    return new Response("A valid ticket command proposal is required", {
      status: 422
    });
  }
  try {
    const identity = await dependencies.verifyWorkforce(request);
    const headers = await dependencies.forwardingHeaders(request, identity);
    headers.set("content-type", "application/json");
    const response = await (dependencies.fetchImpl ?? fetch)(
      `${dependencies.actionsUrl.replace(/\/$/, "")}/commands/tickets`,
      { method: "POST", headers, body: JSON.stringify(proposal) }
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json"
      }
    });
  } catch {
    return new Response(
      "Ticket command was not authorized or could not be completed",
      { status: 403 }
    );
  }
}

export async function action({ request }: { request: Request }) {
  const actionsUrl = process.env.KNOWLEDGE_ACTIONS_URL;
  const actionsAudience = process.env.KNOWLEDGE_ACTIONS_AUDIENCE;
  const companyId = process.env.KNOWLEDGE_COMPANY_ID;
  if (!actionsUrl || !actionsAudience || !companyId) {
    return Response.json(
      { error: "ticket_commands_not_configured" },
      { status: 503 }
    );
  }
  return forwardTicketCommand(request, {
    actionsUrl,
    verifyWorkforce: verifyKnowledgeBrowserRequest,
    forwardingHeaders: (incoming, identity) =>
      forwardVerifiedWorkforceRequest({
        request: incoming,
        targetAudience: actionsAudience,
        companyId,
        verified: identity
      })
  });
}
