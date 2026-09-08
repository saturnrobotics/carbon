import { describe, expect, it, vi } from "vitest";
import { forwardKnowledgeEntity } from "./entity-gateway.server";

const verified = { kind: "iap-browser", claims: {} } as never;

describe("knowledge entity gateway", () => {
  it("authenticates the browser and forwards only a bounded entity request", async () => {
    const fetchImpl = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return Response.json({
        kind: "item",
        title: "Synthetic assembly",
        description: "A public-fixture item.",
        fields: { itemId: "SYN-100", revision: "A", mpn: "SYN-MPN-100" },
        sourceRevision: "projection:abc",
        observedAt: "2026-09-01T00:00:00Z"
      });
    });
    const response = await forwardKnowledgeEntity(
      new Request("https://portal.example/sources/carbon/entities/item-one"),
      { sourceId: "carbon", entityId: "item-one", kind: "item" },
      {
        queryUrl: "https://query.example",
        queryAudience: "query-audience",
        companyId: "cmp_synthetic",
        verifyBrowser: async () => verified,
        forwardingHeaders: async () =>
          new Headers({ authorization: "Bearer fresh" }),
        fetchImpl: fetchImpl as never
      }
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe(
      "https://query.example/v1/entity"
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ sourceId: "carbon", entityId: "item-one", kind: "item" })
    );
  });

  it("rejects unsafe identifiers before browser authentication", async () => {
    const verifyBrowser = vi.fn();
    const response = await forwardKnowledgeEntity(
      new Request("https://portal.example/sources/x/entities/y"),
      { sourceId: "carbon", entityId: "item,companyId.neq.other" },
      {
        queryUrl: "https://query.example",
        queryAudience: "query-audience",
        companyId: "cmp_synthetic",
        verifyBrowser,
        forwardingHeaders: async () => new Headers(),
        fetchImpl: vi.fn() as never
      }
    );

    expect(response.status).toBe(422);
    expect(verifyBrowser).not.toHaveBeenCalled();
  });

  it("fails closed when the source response exceeds its display contract", async () => {
    const response = await forwardKnowledgeEntity(
      new Request("https://portal.example/sources/carbon/entities/item-one"),
      { sourceId: "carbon", entityId: "item-one" },
      {
        queryUrl: "https://query.example",
        queryAudience: "query-audience",
        companyId: "cmp_synthetic",
        verifyBrowser: async () => verified,
        forwardingHeaders: async () => new Headers(),
        fetchImpl: async () =>
          Response.json({
            kind: "item",
            title: "x".repeat(501),
            description: null,
            fields: {},
            sourceRevision: "one",
            observedAt: "2026-09-01T00:00:00Z"
          })
      }
    );

    expect(response.status).toBe(503);
  });
});
