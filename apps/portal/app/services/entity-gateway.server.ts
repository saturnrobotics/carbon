import {
  type SourceEntityRequest,
  sourceEntityRequestSchema,
  sourceEntitySchema
} from "@carbon/portal";
import type { VerifiedIapBrowserRequest } from "@carbon/portal/identity.server";
import {
  forwardVerifiedWorkforceRequest,
  verifyPortalBrowserRequest
} from "./identity.server";

type EntityGatewayDependencies = {
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

export async function forwardPortalEntity(
  request: Request,
  input: SourceEntityRequest,
  dependencies: EntityGatewayDependencies
): Promise<Response> {
  const parsed = sourceEntityRequestSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json({ error: "invalid_entity" }, { status: 422 });
  }
  try {
    const verifyBrowser =
      dependencies.verifyBrowser ?? verifyPortalBrowserRequest;
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
      new URL("/v1/entity", dependencies.queryUrl),
      {
        method: "POST",
        headers,
        body: JSON.stringify(parsed.data)
      }
    );
    if (!response.ok) throw new Error("Entity unavailable");
    const entity = sourceEntitySchema.parse(await response.json());
    return Response.json(entity, {
      headers: { "cache-control": "no-store" }
    });
  } catch {
    return Response.json(
      { error: "entity_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
