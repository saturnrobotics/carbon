import { afterEach, expect, it, vi } from "vitest";

const query = vi.hoisted(() =>
  vi.fn(async () => ({ rows: [{ id: "engineering", kind: "engineering" }] }))
);
vi.mock("@carbon/knowledge/database.server", () => ({
  withKnowledgeTransaction: async (
    _pool: unknown,
    _principal: unknown,
    _mode: unknown,
    operation: (client: unknown) => unknown
  ) => operation({ query })
}));
vi.mock("@carbon/knowledge/identity.server", () => ({
  createWorkforceForwardingHeaders: async () =>
    new Headers({
      authorization: "Bearer fresh-service-token",
      "x-portal-user-evidence": "verified-user-token"
    })
}));

import { getSourceEntity, structuredSourceQuery } from "./sources.server";

const configuration = {
  version: 1 as const,
  sources: [
    {
      id: "engineering",
      kind: "engineering" as const,
      origin: "https://engineering.example",
      audience: "engineering-audience"
    }
  ]
};
const identity = {
  principal: {
    kind: "human" as const,
    actorId: "actor",
    companyId: "company",
    callerId: "query",
    capabilities: ["knowledge.read"],
    policyVersion: "policy",
    sourceIdentity: { issuer: "iap", subject: "actor" }
  },
  companyGroupId: "company",
  allowedOperations: [],
  accessLevels: []
};
const entity = {
  id: "pcb-1",
  type: "pcb",
  title: "Motor controller",
  revision: "B",
  fields: { status: "released" }
};
afterEach(() => vi.unstubAllGlobals());
it("opens a registered engineering entity through its owner API with fresh service credentials", async () => {
  const fetcher = vi.fn(async () => Response.json(entity));
  vi.stubGlobal("fetch", fetcher);
  const request = new Request("https://query.example/v1/entity", {
    method: "POST",
    body: JSON.stringify({ sourceId: "engineering", entityId: "pcb-1" })
  });
  const result = await getSourceEntity({
    request,
    identity,
    pool: {} as never,
    configuration
  });
  expect(result).toMatchObject({
    kind: "pcb",
    title: "Motor controller",
    sourceRevision: "B"
  });
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.toString()).toBe(
    "https://engineering.example/api/knowledge/entities/pcb-1"
  );
  expect(new Headers(options.headers).get("authorization")).toBe(
    "Bearer fresh-service-token"
  );
});
it("routes a bounded generic record search into current evidence without answer inference", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      items: [entity],
      observedAt: "2026-09-01T00:00:00Z",
      sourceRevision: "catalog-1",
      status: "complete"
    })
  );
  const result = await structuredSourceQuery({
    request: new Request("https://query.example"),
    query: {
      requestId: "query-1",
      text: "find pcb motor controller",
      mode: "locate",
      locale: "en"
    },
    identity,
    pool: {} as never,
    configuration,
    origin: "https://portal.example"
  });
  expect(result).toMatchObject({
    kind: "results",
    partial: false,
    claims: [],
    evidence: [
      { entityId: "pcb-1", sourceId: "engineering", freshness: "current" }
    ]
  });
});
it("rejects a producer returning a different entity than requested", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ ...entity, id: "different" })
  );
  const request = new Request("https://query.example/v1/entity", {
    method: "POST",
    body: JSON.stringify({ sourceId: "engineering", entityId: "pcb-1" })
  });
  await expect(
    getSourceEntity({ request, identity, pool: {} as never, configuration })
  ).rejects.toThrow("different entity");
});
