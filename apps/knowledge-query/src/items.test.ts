import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  admit: vi.fn(),
  read: vi.fn()
}));
// The real module, with the verifier replaced: `UnauthorizedRequestError` is
// what production throws, so the handler's denial branch must be tested against
// that class rather than a stand-in a mock invented.
vi.mock("@carbon/knowledge/identity.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@carbon/knowledge/identity.server")
  >()),
  verifyWorkforceRequest: mocks.verify
}));
vi.mock("@carbon/knowledge/budgets.server", () => ({
  admitReadRequest: mocks.admit
}));
vi.mock("@carbon/knowledge/database.server", () => ({
  withKnowledgeTransaction: async (
    _pool: unknown,
    _principal: unknown,
    _mode: unknown,
    operation: (client: unknown) => unknown
  ) => operation({ query: mocks.read })
}));

import { UnauthorizedRequestError } from "@carbon/knowledge/identity.server";
import { createItemSearchHandler } from "./items.server";

const identity = {
  principal: {
    kind: "human",
    actorId: "actor",
    companyId: "company",
    callerId: "portal",
    sourceIdentity: { issuer: "https://issuer.example", subject: "s" },
    policyVersion: "p",
    capabilities: ["knowledge.read"]
  },
  companyGroupId: "company",
  allowedOperations: ["knowledge.query"],
  accessLevels: []
};
const sources = {
  version: 1 as const,
  sources: [
    {
      id: "source-carbon",
      kind: "carbon" as const,
      origin: "https://carbon.example/",
      audience: "carbon"
    }
  ]
};
const baseOptions = {
  pool: {} as never,
  configuration: {} as never,
  identityStore: {} as never,
  tokenVerifier: {} as never
};

function request(body: unknown) {
  return new Request("https://query.example/v1/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue(identity);
  mocks.admit.mockResolvedValue(true);
  mocks.read.mockResolvedValue({ rows: [{ id: "source-carbon" }] });
});

it("answers unavailable, not empty, when no item source is registered", async () => {
  const response = await createItemSearchHandler(baseOptions)(
    request({ search: "motor" })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    items: [],
    status: "unavailable"
  });
  expect(mocks.read).not.toHaveBeenCalled();
});

it("reads bounded candidates through the registered resolveItems operation", async () => {
  const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
    expect(new URL(url.toString()).pathname).toBe(
      "/api/v1/knowledge/resolveItems"
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      search: "motor",
      limit: 40
    });
    return Response.json({
      results: [
        {
          id: "item-1",
          readableId: "EM-100",
          name: "Motor",
          revision: "A",
          mpn: "EM-100-A"
        },
        {
          id: "item-2",
          readableId: "EM-200",
          name: "Motor 2",
          revision: null,
          mpn: null
        }
      ]
    });
  });
  const handler = createItemSearchHandler({
    ...baseOptions,
    sources,
    registryContext: () => ({
      fetch: fetchImpl as unknown as typeof fetch,
      headers: async () => new Headers()
    })
  });
  const response = await handler(request({ search: "motor", limit: 1 }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    items: [
      {
        id: "item-1",
        readableId: "EM-100",
        name: "Motor",
        revision: "A",
        mpn: "EM-100-A",
        sourceId: "source-carbon"
      }
    ],
    status: "partial",
    incompleteReason: "Narrow the search to see every candidate."
  });
});

it.each([
  ["an unbounded search", { search: "x".repeat(257) }, 422],
  ["an unknown field", { search: "motor", sourceId: "x" }, 422]
])("rejects %s before any source call", async (_name, body, status) => {
  const fetchImpl = vi.fn();
  const handler = createItemSearchHandler({
    ...baseOptions,
    sources,
    registryContext: () => ({ fetch: fetchImpl })
  });
  expect((await handler(request(body))).status).toBe(status);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("denies a principal without the read capability and a rate-limited one", async () => {
  mocks.verify.mockResolvedValueOnce({
    ...identity,
    principal: { ...identity.principal, capabilities: [] }
  });
  const handler = createItemSearchHandler({ ...baseOptions, sources });
  expect((await handler(request({ search: "motor" }))).status).toBe(403);
  mocks.admit.mockResolvedValueOnce(false);
  expect((await handler(request({ search: "motor" }))).status).toBe(429);
});

it.each([
  "an unknown caller",
  "a revoked binding",
  "another company's request"
])("refuses %s with the same opaque forbidden, not an outage", async (_case) => {
  // `unauthorized()` is the one helper behind every denial in the verifier and
  // carries no reason, so all three arrive here as the same class and must
  // leave as the same answer.
  mocks.verify.mockRejectedValueOnce(new UnauthorizedRequestError());
  const response = await createItemSearchHandler({ ...baseOptions, sources })(
    request({ search: "motor" })
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "forbidden" });
  expect(mocks.read).not.toHaveBeenCalled();
});

it("keeps 503 for a genuine failure behind the identity check", async () => {
  mocks.read.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.1"));
  const response = await createItemSearchHandler({ ...baseOptions, sources })(
    request({ search: "motor" })
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "items_unavailable" });
  // The message never reaches the caller.
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("keeps the source's own denial and step-up on the unavailable answer", async () => {
  for (const upstream of [
    () => Response.json({ error: "step_up_required" }, { status: 403 }),
    () => Response.json({ error: "forbidden" }, { status: 403 }),
    () => new Response("down", { status: 503 })
  ]) {
    const handler = createItemSearchHandler({
      ...baseOptions,
      sources,
      registryContext: () => ({
        fetch: upstream as unknown as typeof fetch,
        headers: async () => new Headers()
      })
    });
    const response = await handler(request({ search: "motor" }));
    // Unchanged by this fix: only an identity THIS service will not act for
    // becomes a client error. What a source said about its own caller is not
    // this reader's authorization, and step-up on the item path has no portal
    // affordance to redirect to.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "items_unavailable" });
  }
});
