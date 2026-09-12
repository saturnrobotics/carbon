import {
  createWorkforceForwardingHeaders,
  PORTAL_COMPANY_HEADER,
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
  "/api/v1/knowledge/source-changes",
  "/api/knowledge/catalog",
  "/api/knowledge/tickets/search",
  "/api/knowledge/changes",
  "/api/knowledge/entities/search",
  "/api/knowledge/facts/query",
  "/api/knowledge/documents/references",
  "/api/knowledge/access/check"
]);
const entityPath =
  /^\/api\/knowledge\/(?:tickets|entities)\/[A-Za-z0-9_-]{1,256}$/;
const changesPath =
  /^\/api\/knowledge\/changes\?(?:cursor=[A-Za-z0-9_.%-]{0,512}&)?limit=\d{1,3}$/;

/** The interactive budget for one live source read (plan §1.7). */
export const SOURCE_READ_DEADLINE_MS = 1000;
/** A batch worker pull may wait longer; it is never on an interactive path. */
export const SOURCE_CHANGE_FEED_DEADLINE_MS = 10_000;
const REQUEST_LIMIT_BYTES = 32768;
const RESPONSE_LIMIT_BYTES = 262144;
const DENIAL_LIMIT_BYTES = 4096;

export type SourceConnection = { origin: string; audience: string };
export type SourceRequestContext = {
  request: Request;
  identity: VerifiedWorkforceIdentity;
  headers?: () => Promise<Headers>;
  fetch?: typeof fetch;
};
export type MachineSourceRequestContext = {
  companyId: string;
  /** Mints the receiver-audience service credential; never a forwarded one. */
  authorizationHeader: () => Promise<string>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  deadlineMs?: number;
};

/**
 * A source call that did not produce a parsable, permitted response. `status`
 * is the HTTP status the source answered with, or `null` when the request
 * never completed (deadline, network, oversized body). Adapters map it into a
 * structured outcome; nothing about the hidden rows is carried.
 */
export class SourceTransportError extends Error {
  readonly status: number | null;
  readonly reason: "unregistered" | "denied" | "deadline" | "source-error";
  constructor(
    reason: SourceTransportError["reason"],
    status: number | null,
    message: string
  ) {
    super(message);
    this.name = "SourceTransportError";
    this.reason = reason;
    this.status = status;
  }
}

function assertConnection(connection: SourceConnection): URL {
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
  return origin;
}

function assertRegisteredOperation(path: string): void {
  if (
    !operations.has(path) &&
    !entityPath.test(path) &&
    !changesPath.test(path)
  )
    throw new SourceTransportError(
      "unregistered",
      null,
      "Unregistered source operation"
    );
}

async function boundedCall(
  origin: URL,
  method: "GET" | "POST",
  path: string,
  headers: Headers,
  body: unknown,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text && new TextEncoder().encode(text).length > REQUEST_LIMIT_BYTES)
    throw Error("Source request limit exceeded");
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, origin), {
      method,
      headers,
      body: text,
      redirect: "error",
      signal
    });
  } catch {
    if (signal.aborted)
      throw new SourceTransportError("deadline", null, "Deadline exceeded");
    throw new SourceTransportError("source-error", null, "Source unreachable");
  }
  if (response.status === 403 && response.body) {
    // A source that requires Carbon MFA says so in a structured body;
    // every other denial stays opaque.
    let denial: unknown;
    try {
      denial = JSON.parse(await readBounded(response.body, DENIAL_LIMIT_BYTES));
    } catch {
      denial = undefined;
    }
    if (isStepUpRequiredBody(denial)) throw new StepUpRequiredError();
  }
  if (!response.ok || !response.body) {
    const denied = response.status === 401 || response.status === 403;
    throw new SourceTransportError(
      denied ? "denied" : "source-error",
      response.status,
      denied ? "Source access denied" : "Source unavailable"
    );
  }
  return JSON.parse(
    await readBounded(response.body, RESPONSE_LIMIT_BYTES)
  ) as unknown;
}

/** Forwards the verified employee's evidence with a fresh service credential. */
export function createSourceTransport(
  connection: SourceConnection,
  context: SourceRequestContext
) {
  const origin = assertConnection(connection);
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    return withDeadline(
      SOURCE_READ_DEADLINE_MS,
      async (signal) => {
        assertRegisteredOperation(path);
        if (
          context.identity.principal.kind !== "human" ||
          !context.identity.principal.capabilities.includes("knowledge.read")
        )
          throw new SourceTransportError(
            "denied",
            null,
            "Source access denied"
          );
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
        return boundedCall(
          origin,
          method,
          path,
          headers,
          body,
          signal,
          context.fetch ?? fetch
        );
      },
      context.request.signal
    ).catch((error) => {
      if (
        error instanceof Error &&
        !(error instanceof SourceTransportError) &&
        error.message === "Deadline exceeded"
      )
        throw new SourceTransportError("deadline", null, error.message);
      throw error;
    });
  }
  return {
    post: (path: string, body: unknown) => call("POST", path, body),
    get: (path: string) => call("GET", path)
  };
}

/**
 * A machine-to-machine transport for change feeds. It carries only the
 * receiver-audience service credential and the company scope; employee
 * evidence headers are never present, so a receiver cannot mistake the worker
 * for a person.
 */
export function createMachineSourceTransport(
  connection: SourceConnection,
  context: MachineSourceRequestContext
) {
  const origin = assertConnection(connection);
  if (!context.companyId.trim()) throw Error("Machine company scope required");
  const deadline = context.deadlineMs ?? SOURCE_CHANGE_FEED_DEADLINE_MS;
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    return withDeadline(
      deadline,
      async (signal) => {
        assertRegisteredOperation(path);
        const headers = new Headers();
        headers.set("authorization", await context.authorizationHeader());
        headers.set(PORTAL_COMPANY_HEADER, context.companyId);
        return boundedCall(
          origin,
          method,
          path,
          headers,
          body,
          signal,
          context.fetch ?? fetch
        );
      },
      context.signal
    ).catch((error) => {
      if (
        error instanceof Error &&
        !(error instanceof SourceTransportError) &&
        error.message === "Deadline exceeded"
      )
        throw new SourceTransportError("deadline", null, error.message);
      throw error;
    });
  }
  return {
    post: (path: string, body: unknown) => call("POST", path, body),
    get: (path: string) => call("GET", path)
  };
}
