import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createRemoteWorkforceIdentityStore,
  createWorkforceForwardingHeaders,
  GoogleWorkforceTokenVerifier,
  parseTrustedCallerConfiguration,
  verifyWorkforceRequest
} from "@carbon/knowledge/identity.server";
import { requestBoundary } from "@carbon/knowledge/query/request-boundary.server";
import { createActionsMcpHandler } from "./mcp";
import { handleProcurementCommand } from "./procurement-server";
import { handleTicketCommand } from "./server";

export { executeProcurementDraftCommand } from "./procurement";
export { handleTicketCommand } from "./server";
export { executeTicketCommand } from "./ticket";

export const serviceName = "knowledge-actions";

const REQUIRED_ACTIONS_CONFIGURATION = [
  "KNOWLEDGE_CARBON_SOURCE_AUDIENCE",
  "KNOWLEDGE_CARBON_SOURCE_URL",
  "KNOWLEDGE_IDENTITY_RESOLVER_AUDIENCE",
  "KNOWLEDGE_IDENTITY_RESOLVER_URL",
  "KNOWLEDGE_KANBAN_SOURCE_AUDIENCE",
  "KNOWLEDGE_KANBAN_SOURCE_ID",
  "KNOWLEDGE_KANBAN_SOURCE_URL",
  "KNOWLEDGE_TRUSTED_CALLERS_JSON"
] as const;

export function isActionsReady(environment: NodeJS.ProcessEnv): boolean {
  return REQUIRED_ACTIONS_CONFIGURATION.every((key) =>
    environment[key]?.trim()
  );
}

export function createHandler(environment: NodeJS.ProcessEnv = process.env) {
  const callers = environment.KNOWLEDGE_TRUSTED_CALLERS_JSON;
  const resolverUrl = environment.KNOWLEDGE_IDENTITY_RESOLVER_URL;
  const resolverAudience = environment.KNOWLEDGE_IDENTITY_RESOLVER_AUDIENCE;
  const sourceId = environment.KNOWLEDGE_KANBAN_SOURCE_ID;
  const sourceUrl = environment.KNOWLEDGE_KANBAN_SOURCE_URL;
  const sourceAudience = environment.KNOWLEDGE_KANBAN_SOURCE_AUDIENCE;
  const carbonUrl = environment.KNOWLEDGE_CARBON_SOURCE_URL;
  const carbonAudience = environment.KNOWLEDGE_CARBON_SOURCE_AUDIENCE;
  if (!callers || !resolverUrl || !resolverAudience) {
    return async () =>
      new Response(
        JSON.stringify({ error: "action_handlers_not_configured" }),
        { status: 503 }
      );
  }
  const configuration = parseTrustedCallerConfiguration(callers);
  const verifier = new GoogleWorkforceTokenVerifier();
  // Named once so the HTTP dispatch and the optional MCP transport below run
  // the same handler with the same dependencies; there is no second path.
  const ticketRoute = async (request: Request) => {
    if (!sourceId || !sourceUrl || !sourceAudience) {
      return new Response(
        JSON.stringify({ error: "ticket_action_not_configured" }),
        { status: 503 }
      );
    }
    return handleTicketCommand(request, {
      sourceId,
      sourceUrl,
      verifyWorkforce: (incoming) =>
        verifyWorkforceRequest({
          request: incoming,
          operation: "kanban.ticket.create",
          configuration,
          tokenVerifier: verifier,
          identityStore: createRemoteWorkforceIdentityStore({
            request: incoming,
            resolverUrl,
            resolverAudience
          })
        }),
      forwardingHeaders: (incoming, identity) =>
        createWorkforceForwardingHeaders({
          request: incoming,
          targetAudience: sourceAudience,
          companyId: identity.principal.companyId,
          verified: identity
        })
    });
  };
  const procurementRoute = async (request: Request) => {
    if (!carbonUrl || !carbonAudience) {
      return new Response(
        JSON.stringify({ error: "procurement_action_not_configured" }),
        { status: 503 }
      );
    }
    return handleProcurementCommand(request, {
      sourceUrl: carbonUrl,
      verifyWorkforce: (incoming) =>
        verifyWorkforceRequest({
          request: incoming,
          operation: "knowledge_createProcurementDraft",
          configuration,
          tokenVerifier: verifier,
          identityStore: createRemoteWorkforceIdentityStore({
            request: incoming,
            resolverUrl,
            resolverAudience
          })
        }),
      forwardingHeaders: (incoming, identity) =>
        createWorkforceForwardingHeaders({
          request: incoming,
          targetAudience: carbonAudience,
          companyId: identity.principal.companyId,
          verified: identity
        })
    });
  };
  // Optional transport over the command routes mounted below; off by default.
  const mcpHandler = createActionsMcpHandler({
    environment,
    routes: { "/commands/tickets": ticketRoute }
  });
  return requestBoundary("actions", async (request: Request) => {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/commands/tickets")
      return ticketRoute(request);
    if (request.method === "POST" && pathname === "/commands/procurement")
      return procurementRoute(request);
    if (pathname === "/mcp") return mcpHandler(request);
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404
    });
  });
}

export function startServer(
  port = Number(process.env.PORT ?? "8080"),
  handler = createHandler(),
  environment: NodeJS.ProcessEnv = process.env
) {
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health") {
      const ready = isActionsReady(environment);
      response.writeHead(ready ? 200 : 503).end(
        JSON.stringify({
          status: ready ? "ok" : "not-configured",
          service: serviceName
        })
      );
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const value = Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > 32_768) {
          response
            .writeHead(413)
            .end(JSON.stringify({ error: "request_too_large" }));
          return;
        }
        chunks.push(value);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const incoming = new Request(
        new URL(request.url ?? "/", "http://actions.internal"),
        {
          method: request.method,
          headers,
          ...(bytes ? { body: Buffer.concat(chunks) } : {})
        }
      );
      const result = await handler(incoming);
      result.headers.forEach((value, key) => {
        response.setHeader(key, value);
      });
      response
        .writeHead(result.status)
        .end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response
        .writeHead(503)
        .end(JSON.stringify({ error: "action_unavailable" }));
    }
  }).listen(port, "0.0.0.0");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer();
}
