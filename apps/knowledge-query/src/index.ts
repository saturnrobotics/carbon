import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createRedisCache } from "@carbon/knowledge/cache/redis.server";
import {
  GoogleWorkforceTokenVerifier,
  parseTrustedCallerConfiguration
} from "@carbon/knowledge/identity.server";
import { postgresIdentityStore } from "@carbon/knowledge/identity-store.server";
import { requestBoundary } from "@carbon/knowledge/query/request-boundary.server";
import { readManualSourceConfiguration } from "@carbon/knowledge/release-profile";
import { Pool } from "pg";
import { handleIdentityRequest } from "./identity.server";
import { createReadHandler } from "./query.server";

export const serviceName = "knowledge-query";

const REQUIRED_QUERY_CONFIGURATION = [
  "KNOWLEDGE_BUSINESS_TIMEZONE",
  "KNOWLEDGE_PORTAL_ORIGIN",
  "KNOWLEDGE_READ_DATABASE_URL",
  "KNOWLEDGE_REDIS_URL",
  "KNOWLEDGE_TRUSTED_CALLERS_JSON",
  "KNOWLEDGE_MANUAL_SOURCE_JSON"
] as const;

export function isQueryReady(environment: NodeJS.ProcessEnv): boolean {
  try {
    readManualSourceConfiguration(environment);
    if (!REQUIRED_QUERY_CONFIGURATION.every((key) => environment[key]?.trim()))
      return false;
    parseTrustedCallerConfiguration(
      environment.KNOWLEDGE_TRUSTED_CALLERS_JSON!
    );
    return true;
  } catch {
    return false;
  }
}

export function createHandler(
  environment: NodeJS.ProcessEnv = process.env
): (request: Request) => Promise<Response> {
  if (!isQueryReady(environment))
    return async () =>
      Response.json({ error: "query_not_configured" }, { status: 503 });
  const manual = readManualSourceConfiguration(environment);
  const configuration = parseTrustedCallerConfiguration(
    environment.KNOWLEDGE_TRUSTED_CALLERS_JSON!
  );
  const pool = new Pool({
    connectionString: environment.KNOWLEDGE_READ_DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 30000,
    statement_timeout: 2000
  });
  pool.on("error", () => {
    /* Request boundaries report redacted failures. */
  });
  const identityStore = postgresIdentityStore(pool);
  const tokenVerifier = new GoogleWorkforceTokenVerifier();
  const cacheStore = createRedisCache(environment.KNOWLEDGE_REDIS_URL!).store;
  const readHandler = createReadHandler({
    manualSourceId: manual.sourceId,
    configuration,
    identityStore,
    tokenVerifier,
    pool,
    cacheStore,
    origin: environment.KNOWLEDGE_PORTAL_ORIGIN!,
    businessTimezone: environment.KNOWLEDGE_BUSINESS_TIMEZONE!
  });
  return requestBoundary("query", async (request) => {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/v1/identity")
      return handleIdentityRequest(request, {
        configuration,
        identityStore,
        tokenVerifier
      });
    if (request.method === "POST" && pathname === "/v1/query")
      return readHandler(request);
    return Response.json({ error: "not_found" }, { status: 404 });
  });
}

export function startServer(
  port = Number(process.env.PORT ?? "8080"),
  handler = createHandler(),
  environment: NodeJS.ProcessEnv = process.env
) {
  const server = createServer(async (incoming, outgoing) => {
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.setHeader("cache-control", "no-store");
    if (incoming.method === "GET" && incoming.url === "/health") {
      const ready = isQueryReady(environment);
      outgoing.writeHead(ready ? 200 : 503).end(
        JSON.stringify({
          status: ready ? "ok" : "not-configured",
          service: serviceName
        })
      );
      return;
    }
    try {
      const chunks: Buffer[] = [];
      const maximumBytes = 32768;
      let size = 0;
      for await (const chunk of incoming) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > maximumBytes) {
          outgoing
            .writeHead(413)
            .end(JSON.stringify({ error: "request_too_large" }));
          return;
        }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(
        new URL(incoming.url ?? "/", "http://query.internal"),
        {
          method: incoming.method,
          headers,
          ...(size ? { body: Buffer.concat(chunks) } : {})
        }
      );
      const response = await handler(request);
      response.headers.forEach((value, key) => {
        outgoing.setHeader(key, value);
      });
      outgoing
        .writeHead(response.status)
        .end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing
        .writeHead(503)
        .end(JSON.stringify({ error: "service_unavailable" }));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server.listen(port, "0.0.0.0");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startServer();
