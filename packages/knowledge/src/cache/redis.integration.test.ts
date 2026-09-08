import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createRedisCache } from "./redis.server";

it("the first connection can populate and read an authorized cache envelope", async () => {
  const configured = process.env.KNOWLEDGE_TEST_REDIS_URL;
  if (!configured) throw Error("Explicit disposable Redis URL required");
  const url = new URL(configured);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    (url.protocol !== "redis:" && url.protocol !== "rediss:") ||
    !url.port ||
    url.port === "6379" ||
    process.env.KNOWLEDGE_TEST_DATABASE_DISPOSABLE !== "1"
  )
    throw Error("Refusing non-disposable Redis");
  const cache = createRedisCache(configured);
  try {
    const key = `knowledge:test:${randomUUID()}`;
    await cache.store.set(key, { synthetic: true }, 1);
    expect(await cache.store.get(key)).toEqual({ synthetic: true });
  } finally {
    await cache.close();
  }
});
