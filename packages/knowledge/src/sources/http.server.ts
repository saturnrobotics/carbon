import {
  createWorkforceForwardingHeaders,
  type VerifiedWorkforceIdentity
} from "../identity.server";
import { withDeadline } from "../query/deadline.server";

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
        if (!response.ok || !response.body)
          throw Error("Source unavailable or access denied");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 262144) throw Error("Source response limit exceeded");
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
        return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
      },
      context.request.signal
    );
  }
  return {
    post: (path: string, body: unknown) => call("POST", path, body),
    get: (path: string) => call("GET", path)
  };
}
