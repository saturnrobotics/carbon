import {
  itemSearchRequestSchema,
  itemSearchResultSchema
} from "@carbon/knowledge";
import type { VerifiedIapBrowserRequest } from "@carbon/knowledge/identity.server";
import {
  forwardVerifiedWorkforceRequest,
  verifyKnowledgeBrowserRequest
} from "./identity.server";

type ItemGatewayDependencies = {
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

/** Browser-side existing-item lookup for intake review. Same checks as the
 * query gateway: same-origin JSON POST, IAP verification, fresh forwarding
 * headers, and a bounded validated response. */
export async function forwardItemSearch(
  request: Request,
  dependencies: ItemGatewayDependencies
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (
    !sameOrigin(request) ||
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    return new Response("Invalid item search request", { status: 403 });
  let payload: unknown;
  try {
    payload = itemSearchRequestSchema.parse(await request.json());
  } catch {
    return new Response("A valid bounded item search is required", {
      status: 422
    });
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
      new URL("/v1/items", dependencies.queryUrl),
      { method: "POST", headers, body: JSON.stringify(payload) }
    );
    if (!response.ok)
      return Response.json(
        { error: "items_unavailable" },
        { status: response.status, headers: { "cache-control": "no-store" } }
      );
    const result = itemSearchResultSchema.parse(await response.json());
    return Response.json(result, {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  } catch {
    return Response.json(
      { error: "items_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
