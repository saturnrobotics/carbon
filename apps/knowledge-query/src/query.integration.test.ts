import { getDisposableLocalDatabaseUrl } from "@carbon/knowledge/test/database";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createReadHandler } from "./query.server";

const pool = new Pool({
  connectionString: getDisposableLocalDatabaseUrl(),
  options: "-c role=knowledge_read",
  max: 4
});
afterAll(() => pool.end());
const configuration = {
  version: 1 as const,
  receiver: { id: "query", audience: "query-aud" },
  callers: [
    {
      callerId: "web",
      serviceAccountSubject: "sa-web",
      sourceIapAudience: "iap-web",
      operations: ["knowledge.query"],
      capabilities: ["knowledge.read"],
      requiredAccessLevels: []
    }
  ]
};
const tokenVerifier = {
  verifyServiceToken: async () => ({
    iss: "https://accounts.google.com",
    sub: "sa-web",
    aud: "query-aud",
    iat: 900,
    exp: 1200
  }),
  verifyIapToken: async () => ({
    iss: "https://cloud.google.com/iap",
    sub: "subject-b",
    aud: "iap-web",
    iat: 900,
    exp: 1200
  })
};
const binding = {
  actorId: "bob",
  companyId: "company-b",
  companyGroupId: "company-b",
  bindingActive: true,
  userActive: true,
  membershipActive: true,
  revocationVersion: 1,
  permissionsVersion: "1",
  capabilities: ["knowledge.read"]
};
const request = (company = "company-b", id = "r1") =>
  new Request("https://query.example/v1/query", {
    method: "POST",
    headers: {
      authorization: "Bearer service",
      "x-portal-user-evidence": "iap",
      "x-portal-company-id": company,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requestId: id,
      text: "manual",
      mode: "locate",
      locale: "en"
    })
  });
describe("read endpoint over real non-owner PostgreSQL RLS", () => {
  it("returns a permitted document and rechecks a warmed cache after membership revocation", async () => {
    let active = true;
    const values = new Map<string, unknown>();
    const handler = createReadHandler({
      pool,
      configuration,
      tokenVerifier,
      nowEpochSeconds: 1000,
      identityStore: {
        resolveHuman: async () => ({ ...binding, membershipActive: active })
      },
      origin: "https://portal.example",
      businessTimezone: "UTC",
      cacheStore: {
        get: async (key) => values.get(key),
        set: async (key, value) => {
          values.set(key, value);
        }
      }
    });
    const initial = await handler(request());
    expect(initial.status).toBe(200);
    const body = await initial.json();
    expect(body.evidence.map((row: { id: string }) => row.id)).toEqual([
      "chunk-doc-b"
    ]);
    expect(values.size).toBe(1);
    const cached = await handler(request("company-b", "r2"));
    expect((await cached.json()).requestId).toBe("r2");
    active = false;
    const denied = await handler(request());
    expect(denied.status).not.toBe(200);
  });
  it("manual release forces evidence-only results and rejects a different source", async () => {
    const handler = createReadHandler({
      pool,
      configuration,
      tokenVerifier,
      nowEpochSeconds: 1000,
      manualSourceId: "source-b",
      identityStore: { resolveHuman: async () => binding },
      origin: "https://portal.example",
      businessTimezone: "UTC",
      cacheStore: { get: async () => undefined, set: async () => {} }
    });
    const manualRequest = (body: Record<string, unknown>) =>
      new Request("https://query.example/v1/query", {
        method: "POST",
        headers: {
          authorization: "Bearer service",
          "x-portal-user-evidence": "iap",
          "x-portal-company-id": "company-b",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requestId: "manual-profile",
          text: "manual",
          mode: "read",
          locale: "en",
          ...body
        })
      });
    const found = await handler(manualRequest({}));
    expect(found.status).toBe(200);
    const result = await found.json();
    expect(result.kind).toBe("results");
    expect(result.claims).toEqual([]);
    expect(
      result.evidence.map((row: { sourceId: string }) => row.sourceId)
    ).toEqual(["source-b"]);
    const denied = await handler(
      manualRequest({ context: { source: "source-a" } })
    );
    expect(denied.status).toBe(403);
    const command = await handler(manualRequest({ text: "create a ticket" }));
    expect(command.status).toBe(403);
  });
  it("rejects a company switch before any private result", async () => {
    const handler = createReadHandler({
      pool,
      configuration,
      tokenVerifier,
      nowEpochSeconds: 1000,
      identityStore: { resolveHuman: async () => binding },
      origin: "https://portal.example",
      businessTimezone: "UTC",
      cacheStore: { get: async () => undefined, set: async () => {} }
    });
    const denied = await handler(request("company-a"));
    expect(denied.status).not.toBe(200);
    expect(await denied.text()).not.toContain("manual");
  });
});
