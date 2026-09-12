import {
  createWorkforceForwardingHeaders,
  type VerifiedWorkforceIdentity
} from "../identity.server";
import { withDeadline } from "../query/deadline.server";
import { isStepUpRequiredBody, StepUpRequiredError } from "../step-up";

async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw Error("Source response limit exceeded");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

const operations = new Set([
  "/api/v1/knowledge/resolveItems",
  "/api/v1/knowledge/getRecentReceipts",
  "/api/v1/knowledge/getRecentReceiptItems",
  "/api/v1/knowledge/getItemIdentity",
  "/api/v1/knowledge/getDocumentReferences",
  "/api/v1/knowledge/getPurchaseStatus",
  "/api/knowledge/catalog",
  "/api/knowledge/tickets/search",
  "/api/knowledge/entities/search",
  "/api/knowledge/facts/query",
  "/api/knowledge/documents/references",
  "/api/knowledge/access/check"
]);
export type SourceConnection = { origin: string; audience: string };
export type SourceRequestContext = {
  request: Request;
  identity: VerifiedWorkforceIdentity;
  headers?: () => Promise<Headers>;
  fetch?: typeof fetch;
};
export function createSourceTransport(
  connection: SourceConnection,
  context: SourceRequestContext
) {
  const origin = new URL(connection.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !connection.audience
  )
    throw Error("Invalid configured source origin");
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    return withDeadline(
      1000,
      async (signal) => {
        if (
          !operations.has(path) &&
          !/^\/api\/knowledge\/(?:tickets|entities)\/[A-Za-z0-9_-]{1,256}$/.test(
            path
          )
        )
          throw Error("Unregistered source operation");
        if (
          context.identity.principal.kind !== "human" ||
          !context.identity.principal.capabilities.includes("knowledge.read")
        )
          throw Error("Source access denied");
        const text = body === undefined ? undefined : JSON.stringify(body);
        if (text && new TextEncoder().encode(text).length > 32768)
          throw Error("Source request limit exceeded");
        const headers = await (
          context.headers ??
          (() =>
            createWorkforceForwardingHeaders({
              request: context.request,
              targetAudience: connection.audience,
              companyId: context.identity.principal.companyId,
              verified: context.identity
            }))
        )();
        headers.set("content-type", "application/json");
        const response = await (context.fetch ?? fetch)(new URL(path, origin), {
          method,
          headers,
          body: text,
          redirect: "error",
          signal
        });
        if (response.status === 403 && response.body) {
          // A source that requires Carbon MFA says so in a structured body;
          // every other denial stays opaque.
          let denial: unknown;
          try {
            denial = JSON.parse(await readBounded(response.body, 4096));
          } catch {
            denial = undefined;
          }
          if (isStepUpRequiredBody(denial)) throw new StepUpRequiredError();
        }
        if (!response.ok || !response.body)
          throw Error("Source unavailable or access denied");
        return JSON.parse(await readBounded(response.body, 262144)) as unknown;
      },
      context.request.signal
    );
  }
  return {
    post: (path: string, body: unknown) => call("POST", path, body),
    get: (path: string) => call("GET", path)
  };
}
