import { describe, expect, it } from "vitest";
import { entityPageSchema, factQuerySchema } from "./contract";
import { createGenericReadAdapter } from "./generic.server";

const page = {
  items: [
    {
      id: "part-1",
      type: "pcb",
      title: "Controller",
      revision: "B",
      fields: { status: "released" }
    }
  ],
  observedAt: "2026-09-01T00:00:00Z",
  sourceRevision: "1",
  status: "complete"
};
describe("generic source conformance", () => {
  it("accepts a finite engineering projection and rejects accidental private fields", () => {
    expect(entityPageSchema.parse(page).items[0]?.type).toBe("pcb");
    expect(() =>
      entityPageSchema.parse({
        ...page,
        items: [{ ...page.items[0], supplierPrice: 100 }]
      })
    ).toThrow();
  });
  it("rejects unlimited rows and arbitrary fact execution", () => {
    expect(() =>
      entityPageSchema.parse({ ...page, items: Array(101).fill(page.items[0]) })
    ).toThrow();
    expect(() =>
      factQuerySchema.parse({
        entityId: "part-1",
        fact: "SELECT * FROM customer"
      })
    ).toThrow();
  });
  it("does not allow a producer to broaden a requested ACL set", async () => {
    const adapter = createGenericReadAdapter(
      { origin: "https://source.example", audience: "aud" },
      {
        request: new Request("https://query.example"),
        identity: {
          principal: {
            kind: "human",
            actorId: "alice",
            companyId: "a",
            callerId: "query",
            sourceIdentity: { issuer: "iap", subject: "a" },
            policyVersion: "1",
            capabilities: ["knowledge.read"]
          },
          companyGroupId: "a",
          allowedOperations: [],
          accessLevels: []
        },
        headers: async () => new Headers(),
        fetch: async () =>
          Response.json({
            allowedIds: ["hidden"],
            policyVersion: "1",
            validUntil: "2026-09-01T00:00:00Z"
          })
      }
    );
    await expect(adapter.checkAccess(["visible"])).rejects.toThrow("expanded");
  });
});

it("registers engineering and CRM producers through the same verified finite transport", async () => {
  const { createSourceRegistry } = await import("./registry.server");
  const registry = createSourceRegistry(
    {
      version: 1,
      sources: [
        {
          id: "engineering",
          kind: "engineering",
          origin: "https://source.example",
          audience: "aud"
        }
      ]
    },
    {
      request: new Request("https://query.example"),
      identity: {
        principal: {
          kind: "human",
          actorId: "alice",
          companyId: "a",
          callerId: "query",
          sourceIdentity: { issuer: "iap", subject: "a" },
          policyVersion: "1",
          capabilities: ["knowledge.read"]
        },
        companyGroupId: "a",
        allowedOperations: [],
        accessLevels: []
      },
      headers: async () => new Headers(),
      fetch: async () => Response.json(page)
    }
  );
  expect(
    (
      await registry
        .generic("engineering")
        .searchEntities({ query: "controller", limit: 10 })
    ).items[0]?.type
  ).toBe("pcb");
  expect(() => registry.generic("unregistered")).toThrow();
});
