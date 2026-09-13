import { beforeEach, describe, expect, it, vi } from "vitest";

const { createReadHandler, createItemSearchHandler } = vi.hoisted(() => ({
  createReadHandler: vi.fn<
    (
      options: Record<string, unknown>
    ) => (request: Request) => Promise<Response>
  >(() => async () => Response.json({})),
  createItemSearchHandler: vi.fn<
    (
      options: Record<string, unknown>
    ) => (request: Request) => Promise<Response>
  >(() => async () => Response.json({}))
}));
vi.mock("./query.server", () => ({ createReadHandler }));
vi.mock("./items.server", () => ({ createItemSearchHandler }));

import {
  createHandler,
  isQueryReady,
  readSourceRegistryConfiguration
} from "./index";

const registry = {
  version: 1,
  sources: [
    {
      id: "carbon-source",
      kind: "carbon",
      origin: "https://erp.example",
      audience: "erp-receiver-audience"
    }
  ]
};

const environment = {
  KNOWLEDGE_BUSINESS_TIMEZONE: "UTC",
  KNOWLEDGE_PORTAL_ORIGIN: "https://portal.example.com",
  KNOWLEDGE_READ_DATABASE_URL: "postgresql://unused@127.0.0.1:59999/unused",
  KNOWLEDGE_REDIS_URL: "redis://127.0.0.1:59998",
  KNOWLEDGE_RELEASE_PROFILE: "manual-v1",
  KNOWLEDGE_MANUAL_SOURCE_JSON: JSON.stringify({
    sourceId: "manuals",
    displayName: "Manual library"
  }),
  KNOWLEDGE_TRUSTED_CALLERS_JSON: JSON.stringify({
    version: 1,
    receiver: { id: "query", audience: "query-audience" },
    callers: [
      {
        callerId: "web",
        serviceAccountSubject: "web-subject",
        sourceIapAudience: "iap-audience",
        operations: ["knowledge.query"],
        capabilities: ["knowledge.read"],
        requiredAccessLevels: []
      }
    ]
  })
};

/** A registry value that is malformed for `reason`. */
const rejected: [reason: string, value: string][] = [
  ["not JSON at all", "{"],
  ["an empty object with no version or sources", "{}"],
  ["an unversioned registry", JSON.stringify({ sources: [] })],
  [
    "an unregistered connector kind",
    JSON.stringify({
      version: 1,
      sources: [{ ...registry.sources[0], kind: "sharepoint" }]
    })
  ],
  [
    "a plaintext origin",
    JSON.stringify({
      version: 1,
      sources: [{ ...registry.sources[0], origin: "http://erp.example" }]
    })
  ],
  [
    "credentials embedded in the origin",
    JSON.stringify({
      version: 1,
      sources: [
        { ...registry.sources[0], origin: "https://user:secret@erp.example" }
      ]
    })
  ],
  [
    "a password-only credential in the origin",
    JSON.stringify({
      version: 1,
      sources: [
        { ...registry.sources[0], origin: "https://:secret@erp.example" }
      ]
    })
  ],
  [
    "an origin carrying a path",
    JSON.stringify({
      version: 1,
      sources: [
        { ...registry.sources[0], origin: "https://erp.example/knowledge" }
      ]
    })
  ],
  [
    "two sources sharing one id",
    JSON.stringify({
      version: 1,
      sources: [
        registry.sources[0],
        { ...registry.sources[0], origin: "https://other.example" }
      ]
    })
  ],
  [
    "an unknown field on a source",
    JSON.stringify({
      version: 1,
      sources: [{ ...registry.sources[0], token: "secret" }]
    })
  ]
];

beforeEach(() => {
  createReadHandler.mockClear();
  createItemSearchHandler.mockClear();
});

describe("source registry configuration", () => {
  it("reaches both read paths when a registry is configured", () => {
    createHandler({
      ...environment,
      KNOWLEDGE_SOURCES_JSON: JSON.stringify(registry)
    });
    for (const constructed of [createReadHandler, createItemSearchHandler]) {
      expect(constructed).toHaveBeenCalledTimes(1);
      expect(constructed.mock.calls[0]?.[0]).toMatchObject({
        sources: registry
      });
    }
  });

  it("registers no source when the key is absent, leaving the manual path alone", () => {
    expect(isQueryReady(environment)).toBe(true);
    expect(readSourceRegistryConfiguration(environment)).toBeUndefined();
    createHandler(environment);
    for (const constructed of [createReadHandler, createItemSearchHandler])
      expect(constructed.mock.calls[0]?.[0]).not.toHaveProperty("sources");
  });

  it("treats a blank value as absence rather than as an empty registry", () => {
    expect(
      readSourceRegistryConfiguration({
        ...environment,
        KNOWLEDGE_SOURCES_JSON: "   "
      })
    ).toBeUndefined();
  });

  it.each(
    rejected
  )("refuses to become ready on %s rather than starting with no sources", async (_reason, value) => {
    const broken = { ...environment, KNOWLEDGE_SOURCES_JSON: value };
    expect(() => readSourceRegistryConfiguration(broken)).toThrow();
    expect(isQueryReady(broken)).toBe(false);
    const response = await createHandler(broken)(
      new Request("https://query.example.com/v1/query", { method: "POST" })
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "query_not_configured" });
    // Refusing means refusing before construction: a malformed registry must
    // not produce a service answering "no item source is configured", which
    // reads as an empty corpus rather than as a broken release.
    expect(createReadHandler).not.toHaveBeenCalled();
    expect(createItemSearchHandler).not.toHaveBeenCalled();
  });

  it("accepts a registry holding every registered connector kind", () => {
    const every = {
      version: 1,
      sources: (["carbon", "kanban", "engineering", "crm"] as const).map(
        (kind) => ({
          id: `${kind}-source`,
          kind,
          origin: `https://${kind}.example`,
          audience: `${kind}-audience`
        })
      )
    };
    expect(
      readSourceRegistryConfiguration({
        ...environment,
        KNOWLEDGE_SOURCES_JSON: JSON.stringify(every)
      })
    ).toEqual(every);
  });
});
