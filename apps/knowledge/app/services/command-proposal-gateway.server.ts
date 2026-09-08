import type { VerifiedIapBrowserRequest } from "@carbon/knowledge/identity.server";
import { z } from "zod";
import {
  forwardVerifiedWorkforceRequest,
  verifyKnowledgeBrowserRequest
} from "./identity.server";

const proposalRequestSchema = z
  .object({
    requestId: z.string().min(1).max(256).regex(/^\S+$/),
    text: z.string().trim().min(1).max(8_000),
    locale: z.string().min(2).max(35),
    boardId: z.string().min(1).max(256).optional()
  })
  .strict();

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

export async function forwardCommandProposal(
  request: Request,
  options: {
    queryUrl: string;
    queryAudience: string;
    companyId: string;
    verifyBrowser?: (request: Request) => Promise<VerifiedIapBrowserRequest>;
    forwardingHeaders?: (
      request: Request,
      identity: VerifiedIapBrowserRequest
    ) => Promise<Headers>;
    fetchImpl?: typeof fetch;
  }
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (
    !sameOrigin(request) ||
    !request.headers.get("content-type")?.startsWith("application/json")
  ) {
    return new Response("Invalid command proposal request", { status: 403 });
  }
  let body: z.infer<typeof proposalRequestSchema>;
  try {
    body = proposalRequestSchema.parse(await request.json());
  } catch {
    return new Response("A valid bounded command request is required", {
      status: 422
    });
  }
  try {
    const identity = await (
      options.verifyBrowser ?? verifyKnowledgeBrowserRequest
    )(request);
    const headers = await (
      options.forwardingHeaders ??
      ((incoming, verified) =>
        forwardVerifiedWorkforceRequest({
          request: incoming,
          targetAudience: options.queryAudience,
          companyId: options.companyId,
          verified
        }))
    )(request, identity);
    headers.set("content-type", "application/json");
    const response = await (options.fetchImpl ?? fetch)(
      new URL("/v1/propose-command", options.queryUrl),
      { method: "POST", headers, body: JSON.stringify(body) }
    );
    if (!response.ok)
      return Response.json(
        { error: "command_proposal_unavailable" },
        { status: response.status, headers: { "cache-control": "no-store" } }
      );
    return new Response(await response.text(), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    });
  } catch {
    return Response.json(
      { error: "command_proposal_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
