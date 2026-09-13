import {
  createLineSplitter,
  decodeQueryStreamLine,
  type QueryStreamEvent
} from "@carbon/knowledge/query/stream";
import { getDisposableLocalDatabaseUrl } from "@carbon/knowledge/test/database";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createConversationStore } from "./conversation.server";
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
      cacheStore: { get: async () => undefined, set: async () => undefined }
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
  it("streams authorized evidence before the result and keeps follow-up context only while authorized", async () => {
    let active = true;
    const conversations = new Map<string, unknown>();
    const handler = createReadHandler({
      pool,
      configuration,
      tokenVerifier,
      nowEpochSeconds: 1000,
      manualSourceId: "source-b",
      identityStore: {
        resolveHuman: async () => ({ ...binding, membershipActive: active })
      },
      origin: "https://portal.example",
      businessTimezone: "UTC",
      cacheStore: { get: async () => undefined, set: async () => undefined },
      conversationStore: createConversationStore({
        get: async (key) => conversations.get(key),
        set: async (key, value) => {
          conversations.set(key, value);
        }
      })
    });
    const streamed = (text: string, id: string) =>
      new Request("https://query.example/v1/query", {
        method: "POST",
        headers: {
          authorization: "Bearer service",
          accept: "application/x-ndjson",
          "x-portal-user-evidence": "iap",
          "x-portal-company-id": "company-b",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requestId: id,
          text,
          mode: "auto",
          locale: "en",
          context: { conversationId: "conversation-1" }
        })
      });
    const events = async (response: Response) => {
      const reader = response
        .body!.pipeThrough(createLineSplitter())
        .getReader();
      const seen: QueryStreamEvent[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const event = decodeQueryStreamLine(next.value);
        if (event) seen.push(event);
      }
      return seen;
    };
    const first = await handler(streamed("manual", "stream-1"));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/x-ndjson");
    const firstEvents = await events(first);
    expect(firstEvents.map((event) => event.type)).toEqual([
      "progress",
      "evidence",
      "result"
    ]);
    expect(firstEvents[1]).toMatchObject({
      evidence: [{ id: "chunk-doc-b" }]
    });
    expect(firstEvents[2]).toMatchObject({
      result: { requestId: "stream-1", kind: "results" }
    });
    // Only evidence ids were stored, under this actor.
    expect([...conversations.values()]).toEqual([
      expect.objectContaining({
        actorId: "bob",
        companyId: "company-b",
        evidenceIds: ["chunk-doc-b"]
      })
    ]);
    // A follow-up whose words match nothing still has the shown manual in context.
    const followUp = await events(
      await handler(streamed("zzqx-no-such-term", "stream-2"))
    );
    expect(followUp.at(-1)).toMatchObject({
      result: { kind: "results", evidence: [{ id: "chunk-doc-b" }] }
    });
    // Once the membership is revoked the context grants nothing: the same
    // follow-up is refused before any evidence is streamed.
    active = false;
    const revoked = await handler(streamed("zzqx-no-such-term", "stream-3"));
    const revokedEvents = revoked.ok ? await events(revoked) : [];
    expect(revokedEvents.some((event) => event.type === "evidence")).toBe(
      false
    );
    expect(
      revokedEvents.some(
        (event) => event.type === "result" && event.result.evidence.length > 0
      )
    ).toBe(false);
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
      cacheStore: { get: async () => undefined, set: async () => undefined }
    });
    const denied = await handler(request("company-a"));
    expect(denied.status).not.toBe(200);
    expect(await denied.text()).not.toContain("manual");
  });
});
