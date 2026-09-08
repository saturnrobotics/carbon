import type { VerifiedIapBrowserRequest } from "@carbon/knowledge/identity.server";
import {
  forwardVerifiedWorkforceRequest,
  verifyKnowledgeBrowserRequest
} from "../services/identity.server";

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

type ForwardingHeaders = (options: {
  request: Request;
  targetAudience: string;
  companyId: string;
  verified: VerifiedIapBrowserRequest;
}) => Promise<Headers>;

export type TranscriptionForwarderDependencies = {
  queryUrl: string;
  queryAudience: string;
  verifyBrowser: (request: Request) => Promise<VerifiedIapBrowserRequest>;
  resolveCompanyId: (
    request: Request,
    verified: VerifiedIapBrowserRequest
  ) => Promise<string>;
  forwardingHeaders: ForwardingHeaders;
  fetchImpl?: typeof fetch;
};

function requiredRequestId(request: Request) {
  const value = request.headers.get("x-request-id")?.trim();
  if (!value || value.length > 256 || /\s/.test(value)) {
    throw new Response("A bounded request ID is required", { status: 422 });
  }
  return value;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

/**
 * The portal never transcribes or bills. It authenticates IAP before reading
 * caller media, then relays the unchanged multipart bytes to knowledge-query.
 */
export async function forwardTranscription(
  request: Request,
  dependencies: TranscriptionForwarderDependencies
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!sameOrigin(request)) {
    return new Response("Invalid transcription request", { status: 403 });
  }
  const verified = await dependencies.verifyBrowser(request);
  const companyId = await dependencies.resolveCompanyId(request, verified);
  if (!companyId || companyId.length > 256 || /\s/.test(companyId)) {
    throw new Response("No authorized company is selected", { status: 403 });
  }
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new Response("A multipart audio recording is required", {
      status: 415
    });
  }
  const requestId = requiredRequestId(request);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_AUDIO_BYTES) {
    throw new Response("The audio recording exceeds the 20 MB limit", {
      status: 413
    });
  }
  const headers = await dependencies.forwardingHeaders({
    request,
    targetAudience: dependencies.queryAudience,
    companyId,
    verified
  });
  headers.set("content-type", contentType);
  headers.set("x-request-id", requestId);
  return (dependencies.fetchImpl ?? fetch)(
    new URL("/v1/transcribe", dependencies.queryUrl),
    { method: "POST", headers, body }
  );
}

export async function action({ request }: { request: Request }) {
  const queryUrl = process.env.KNOWLEDGE_QUERY_URL;
  const queryAudience = process.env.KNOWLEDGE_QUERY_AUDIENCE;
  // This server configuration selects the active company; it is never read
  // from browser input. knowledge-query still proves the resulting membership.
  const companyId = process.env.KNOWLEDGE_COMPANY_ID;
  if (!queryUrl || !queryAudience || !companyId) {
    return Response.json(
      { error: "transcription_not_configured" },
      { status: 503 }
    );
  }
  try {
    return await forwardTranscription(request, {
      queryUrl,
      queryAudience,
      verifyBrowser: verifyKnowledgeBrowserRequest,
      resolveCompanyId: async () => companyId,
      forwardingHeaders: ({
        request: inbound,
        targetAudience,
        companyId: selectedCompanyId,
        verified
      }) =>
        forwardVerifiedWorkforceRequest({
          request: inbound,
          targetAudience,
          companyId: selectedCompanyId,
          verified
        })
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: "transcription_unavailable" },
      { status: 503 }
    );
  }
}
