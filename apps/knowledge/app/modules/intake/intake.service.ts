import {
  forwardVerifiedWorkforceRequest,
  verifyKnowledgeBrowserRequest
} from "../../services/identity.server";

function configured(environment: NodeJS.ProcessEnv) {
  const workerUrl = environment.KNOWLEDGE_WORKER_URL;
  const workerAudience = environment.KNOWLEDGE_WORKER_AUDIENCE;
  if (!workerUrl || !workerAudience)
    throw new Error("Knowledge intake is not configured");
  return { workerUrl: workerUrl.replace(/\/$/, ""), workerAudience };
}

export function assertSameOrigin(
  request: Request,
  environment: NodeJS.ProcessEnv = process.env
): void {
  const origin = request.headers.get("origin");
  const expected =
    environment.KNOWLEDGE_WEB_ORIGIN ?? new URL(request.url).origin;
  if (origin !== expected)
    throw new Error("Cross-origin knowledge mutation rejected");
}

export async function forwardIntakeRequest(options: {
  request: Request;
  companyId: string;
  workerPath: string;
  body?: BodyInit | null;
  contentType?: string | null;
  method?: string;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const environment = options.environment ?? process.env;
  if (!options.companyId.trim())
    throw new Error("Knowledge company selection is not configured");
  const method = options.method ?? options.request.method;
  if (method !== "GET" && method !== "HEAD")
    assertSameOrigin(options.request, environment);
  const { workerUrl, workerAudience } = configured(environment);
  const verified = await verifyKnowledgeBrowserRequest(
    options.request,
    environment
  );
  const headers = await forwardVerifiedWorkforceRequest({
    request: options.request,
    targetAudience: workerAudience,
    companyId: options.companyId,
    verified
  });
  if (options.contentType) headers.set("content-type", options.contentType);
  const response = await (options.fetchImpl ?? fetch)(
    `${workerUrl}${options.workerPath}`,
    {
      method,
      headers,
      body: options.body
    }
  );
  const returnedHeaders = new Headers({
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff"
  });
  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition");
  if (contentType) returnedHeaders.set("content-type", contentType);
  if (disposition) returnedHeaders.set("content-disposition", disposition);
  return new Response(response.body, {
    status: response.status,
    headers: returnedHeaders
  });
}
