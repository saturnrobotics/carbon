import { queryRequestSchema } from "@carbon/knowledge";
import type { VerifiedIapBrowserRequest } from "@carbon/knowledge/identity.server";
import { queryResultSchema } from "@carbon/knowledge/query";
import {
  forwardVerifiedWorkforceRequest,
  verifyKnowledgeBrowserRequest
} from "./identity.server";

type QueryGatewayDependencies = {
  queryUrl: string;
  queryAudience: string;
  companyId: string;
  verifyBrowser?: (request: Request) => Promise<VerifiedIapBrowserRequest>;
  forwardingHeaders?: (
    request: Request,
    verified: VerifiedIapBrowserRequest,
    companyId: string,
    audience: string
  ) => Promise<Headers>;
  fetchImpl?: typeof fetch;
};

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

export async function forwardKnowledgeQuery(
  request: Request,
  dependencies: QueryGatewayDependencies
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (
    !sameOrigin(request) ||
    !request.headers.get("content-type")?.startsWith("application/json")
  ) {
    return new Response("Invalid query request", { status: 403 });
  }
  let payload: unknown;
  try {
    payload = queryRequestSchema.parse(await request.json());
  } catch {
    return new Response("A valid bounded query is required", { status: 422 });
  }
  try {
    const verifyBrowser =
      dependencies.verifyBrowser ?? verifyKnowledgeBrowserRequest;
    const verified = await verifyBrowser(request);
    const forwardingHeaders =
      dependencies.forwardingHeaders ??
      ((incoming, identity, companyId, targetAudience) =>
        forwardVerifiedWorkforceRequest({
          request: incoming,
          targetAudience,
          companyId,
          verified: identity
        }));
    const headers = await forwardingHeaders(
      request,
      verified,
      dependencies.companyId,
      dependencies.queryAudience
    );
    headers.set("content-type", "application/json");
    const response = await (dependencies.fetchImpl ?? fetch)(
      new URL("/v1/query", dependencies.queryUrl),
      { method: "POST", headers, body: JSON.stringify(payload) }
    );
    if (!response.ok) {
      return Response.json(
        { error: "query_unavailable" },
        { status: response.status, headers: { "cache-control": "no-store" } }
      );
    }
    const result = queryResultSchema.parse(await response.json());
    return Response.json(result, {
      headers: { "cache-control": "no-store" }
    });
  } catch {
    return Response.json(
      { error: "query_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
