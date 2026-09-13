import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createRedisCache } from "@carbon/portal/cache/redis.server";
import {
  GoogleWorkforceTokenVerifier,
  parseTrustedCallerConfiguration
} from "@carbon/portal/identity.server";
import { postgresIdentityStore } from "@carbon/portal/identity-store.server";
import {
  requestBoundary,
  writeWebResponse
} from "@carbon/portal/query/request-boundary.server";
import { readManualSourceConfiguration } from "@carbon/portal/release-profile";
import {
  type SourceRegistryConfiguration,
  sourceRegistryConfigurationSchema
} from "@carbon/portal/sources/registry.server";
import { Pool } from "pg";
import { startCacheIsolationProbe } from "./cache-probe";
import {
  CONVERSATION_TTL_SECONDS,
  createConversationStore
} from "./conversation.server";
import { handleIdentityRequest } from "./identity.server";
import { createItemSearchHandler } from "./items.server";
import { createQueryMcpHandler } from "./mcp";
import { createReadHandler } from "./query.server";

export const serviceName = "portal-query";

const REQUIRED_QUERY_CONFIGURATION = [
  "PORTAL_BUSINESS_TIMEZONE",
  "PORTAL_ORIGIN",
  "PORTAL_READ_DATABASE_URL",
  "PORTAL_REDIS_URL",
  "PORTAL_TRUSTED_CALLERS_JSON",
  "PORTAL_MANUAL_SOURCE_JSON"
] as const;

/**
 * The live-source registry, read the way this service already reads its two
 * other registries: one JSON environment value, parsed at start-up by the same
 * runtime schema every consumer validates against.
 *
 * Absent means the deployment registers no live source, which is the released
 * manual profile's own shape and stays supported. PRESENT AND MALFORMED throws,
 * so the service refuses to become ready rather than starting with no sources:
 * a query that reached no source would answer "no item source is configured for
 * this library", which reads as an empty corpus rather than as a broken
 * release, and nobody would go looking for the typo.
 *
 * HTTPS-only origins with no embedded credentials are the schema's own rule
 * (`registry.server.ts`), the same policy the transport applies to an acquired
 * URL, so the configuration input cannot be a way around it. Pinned by
 * `configuration.test.ts` rather than restated here.
 */
export function readSourceRegistryConfiguration(
  environment: NodeJS.ProcessEnv
): SourceRegistryConfiguration | undefined {
  const raw = environment.PORTAL_SOURCES_JSON?.trim();
  if (!raw) return undefined;
  return sourceRegistryConfigurationSchema.parse(JSON.parse(raw));
}

export function isQueryReady(environment: NodeJS.ProcessEnv): boolean {
  try {
    readManualSourceConfiguration(environment);
    if (!REQUIRED_QUERY_CONFIGURATION.every((key) => environment[key]?.trim()))
      return false;
    parseTrustedCallerConfiguration(environment.PORTAL_TRUSTED_CALLERS_JSON!);
    readSourceRegistryConfiguration(environment);
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
    environment.PORTAL_TRUSTED_CALLERS_JSON!
  );
  const sources = readSourceRegistryConfiguration(environment);
  const pool = new Pool({
    connectionString: environment.PORTAL_READ_DATABASE_URL,
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
  const cacheStore = createRedisCache(environment.PORTAL_REDIS_URL!).store;
  // Follow-up context outlives the answer cache's freshness budget, so it
  // takes its own bounded store on the same Redis.
  const conversationStore = createConversationStore(
    createRedisCache(environment.PORTAL_REDIS_URL!, {
      maxTtlSeconds: CONVERSATION_TTL_SECONDS
    }).store
  );
  const readHandler = createReadHandler({
    manualSourceId: manual.sourceId,
    configuration,
    identityStore,
    tokenVerifier,
    pool,
    cacheStore,
    origin: environment.PORTAL_ORIGIN!,
    businessTimezone: environment.PORTAL_BUSINESS_TIMEZONE!,
    conversationStore,
    ...(sources ? { sources } : {})
  });
  // A deployment that registers no item source still answers `unavailable`
  // rather than empty, so intake review can publish a generic document.
  const itemHandler = createItemSearchHandler({
    configuration,
    identityStore,
    tokenVerifier,
    pool,
    ...(sources ? { sources } : {})
  });
  // Optional transport over the read handler mounted below; off by default.
  const mcpHandler = createQueryMcpHandler({
    environment,
    routes: { "/v1/query": readHandler }
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
    if (request.method === "POST" && pathname === "/v1/items")
      return itemHandler(request);
    if (pathname === "/v1/mcp") return mcpHandler(request);
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
      await writeWebResponse(outgoing, await handler(request));
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer();
  // Periodic cache-leakage self-test; its verdict feeds the security alert policy.
  startCacheIsolationProbe();
}
