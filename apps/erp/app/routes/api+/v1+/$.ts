// Carbon API v1 — the HTTP transport for the service layer.
//
//   POST /api/v1/{module}/{operation}
//
// Every operation is a POST. The splat forwards the request to the oRPC OpenAPIHandler
// after resolving the API key into context. No CORS: keys must not live in browsers.

import type { ActionFunctionArgs } from "react-router";
import { resolveApiContext } from "./lib/authenticate.server";
import { openApiHandler } from "./lib/handler.server";

const PREFIX = "/api/v1";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  // Throws a 401/403/429 Response on auth failure, which propagates as the response.
  const path = new URL(request.url).pathname
    .slice(`${PREFIX}/`.length)
    .split("/");
  if (path.length !== 2 || path.some((part) => !part)) {
    return Response.json({ error: "Operation not found" }, { status: 404 });
  }
  const operation = `${path[0]}_${path[1]}`;
  const context = await resolveApiContext(request, operation);

  const { matched, response } = await openApiHandler.handle(request, {
    prefix: PREFIX,
    context
  });

  if (matched && response) return response;
  return Response.json({ error: "Operation not found" }, { status: 404 });
}

export function loader() {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST, OPTIONS" }
  });
}
