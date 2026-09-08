/** Docker-only query fixture using the production query handler and Redis. */
import { createRedisCache } from "@carbon/knowledge/cache/redis.server";
import { postgresIdentityStore } from "@carbon/knowledge/identity-store.server";
import { Pool } from "pg";
import { createReadHandler } from "../../../knowledge-query/src/query.server";
import {
  localCallerConfiguration,
  localSourceId,
  localTokenVerifier
} from "./local-fixture";
import { startLocalHttpServer } from "./local-http";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the local fixture`);
  return value;
}

async function main() {
  if (process.env.KNOWLEDGE_E2E_SYNTHETIC_FIXTURES !== "1")
    throw new Error("Local synthetic identity is disabled");
  const pool = new Pool({
    connectionString: required("KNOWLEDGE_E2E_DATABASE_URL"),
    options: "-c role=knowledge_read",
    max: 8,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000
  });
  const redis = createRedisCache(required("KNOWLEDGE_REDIS_URL"));
  await redis.store.set("knowledge:e2e:health", { ready: true }, 1);
  if (
    !((await redis.store.get("knowledge:e2e:health")) as { ready?: boolean })
      ?.ready
  )
    throw new Error("Local Redis fixture is unavailable");

  const cacheStats = { gets: 0, hits: 0, sets: 0 };
  const query = createReadHandler({
    pool,
    configuration: localCallerConfiguration("e2e-query"),
    identityStore: postgresIdentityStore(pool),
    tokenVerifier: localTokenVerifier,
    cacheStore: {
      async get(key) {
        cacheStats.gets += 1;
        const value = await redis.store.get(key);
        if (value !== undefined) cacheStats.hits += 1;
        return value;
      },
      async set(key, value, ttlSeconds) {
        cacheStats.sets += 1;
        await redis.store.set(key, value, ttlSeconds);
      }
    },
    origin: "https://localhost:4200",
    businessTimezone: "UTC",
    manualSourceId: localSourceId
  });

  const server = startLocalHttpServer({
    port: Number(process.env.PORT ?? "4302"),
    maximumBytes: 32_768,
    handler: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        await pool.query("SELECT 1");
        return Response.json({
          status: "ok",
          service: "local-query",
          cache: "redis"
        });
      }
      if (request.method === "GET" && url.pathname === "/__e2e/cache")
        return Response.json(cacheStats);
      if (request.method === "POST" && url.pathname === "/v1/query")
        return query(request);
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  });

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([pool.end(), redis.close()]);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

void main().catch(() => {
  process.exitCode = 1;
});
