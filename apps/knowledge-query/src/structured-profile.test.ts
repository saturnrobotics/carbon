import type { QueryRequest } from "@carbon/knowledge";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  admit: vi.fn(),
  read: vi.fn(),
  structured: vi.fn()
}));
// Partial, as everywhere else in this directory: the handler's catch reads
// `UnauthorizedRequestError` off this module, so a total replacement leaves the
// refusal branch testing `instanceof undefined` and every failure path throws
// before it can be classified.
vi.mock("@carbon/knowledge/identity.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@carbon/knowledge/identity.server")
  >()),
  verifyWorkforceRequest: mocks.verify
}));
vi.mock("@carbon/knowledge/budgets.server", () => ({
  admitReadRequest: mocks.admit,
  durableBudget: () => ({ spend: async () => true })
}));
vi.mock("@carbon/knowledge/database.server", () => ({
  withKnowledgeTransaction: async (
    _pool: unknown,
    _principal: unknown,
    _mode: unknown,
    operation: (client: unknown) => unknown
  ) => operation({ query: mocks.read })
}));
vi.mock("./sources.server", () => ({
  structuredSourceQuery: mocks.structured
}));

import { createReadHandler } from "./query.server";

const principal = {
  kind: "human" as const,
  actorId: "actor",
  companyId: "company",
  callerId: "web",
  sourceIdentity: { issuer: "https://issuer.example", subject: "subject" },
  policyVersion: "policy-1",
  capabilities: ["knowledge.read"]
};
const identity = {
  principal,
  companyGroupId: "company",
  allowedOperations: ["knowledge.query"],
  accessLevels: [],
  assurance: { mode: "carbon-mfa" as const }
};
const identityStore = {
  resolveHuman: vi.fn(async () => ({
    actorId: principal.actorId,
    bindingActive: true,
    userActive: true,
    membershipActive: true,
    capabilities: ["knowledge.read"]
  }))
};
const sources = {
  version: 1 as const,
  sources: [
    {
      id: "carbon-source",
      kind: "carbon" as const,
      origin: "https://erp.example",
      audience: "erp-receiver-audience"
    }
  ]
};
const baseOptions = {
  pool: {} as never,
  configuration: {} as never,
  tokenVerifier: {} as never,
  identityStore: identityStore as never,
  // Every case here settles before the answer cache is consulted; the store
  // only has to exist for the handler to be constructed.
  cacheStore: {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined
  } as never,
  origin: "https://portal.example",
  businessTimezone: "UTC"
};

/** A part lookup: `structuredIntent` routes it to a live source, not the index. */
function partLookup(): QueryRequest {
  return {
    requestId: "request-1",
    text: "find the part NEMA 34",
    mode: "auto",
    locale: "en"
  };
}

function request(body: QueryRequest) {
  return new Request("https://query.example/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue(identity);
  mocks.admit.mockResolvedValue(true);
  // No authorized document source, so the manual index path ends in the one
  // abstention it can reach without a database.
  mocks.read.mockResolvedValue({ rows: [] });
  mocks.structured.mockResolvedValue(null);
  identityStore.resolveHuman.mockResolvedValue({
    actorId: principal.actorId,
    bindingActive: true,
    userActive: true,
    membershipActive: true,
    capabilities: ["knowledge.read"]
  });
});

it("reaches a registered source on the manual profile, where the two coexist", async () => {
  mocks.structured.mockResolvedValue({
    requestId: "request-1",
    kind: "results",
    evidence: [],
    claims: [],
    message: "",
    partial: false
  });
  const handler = createReadHandler({
    ...baseOptions,
    manualSourceId: "manuals",
    sources
  });
  const response = await handler(request(partLookup()));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ kind: "results" });
  expect(mocks.structured).toHaveBeenCalledTimes(1);
  const call = mocks.structured.mock.calls[0]?.[0];
  // The reader's own request, not the manual-pinned rewrite: pinning
  // `context.source` to the upload library leaves every registered source
  // unpermitted, which is unreachability under another name.
  expect(call?.query).toEqual(partLookup());
  expect(call?.route.structured).toEqual({
    kind: "parts",
    searchText: "NEMA 34"
  });
  expect(call?.configuration).toBe(sources);
});

it("carries an ambiguity choice through, which the manual pin used to drop", async () => {
  const chosen: QueryRequest = {
    ...partLookup(),
    context: { entityId: "item-1" }
  };
  const handler = createReadHandler({
    ...baseOptions,
    manualSourceId: "manuals",
    sources
  });
  await handler(request(chosen));
  expect(mocks.structured.mock.calls[0]?.[0]?.query.context).toEqual({
    entityId: "item-1"
  });
});

it("keeps the manual path primary: a structured miss still answers from the library", async () => {
  const handler = createReadHandler({
    ...baseOptions,
    manualSourceId: "manuals",
    sources
  });
  const response = await handler(request(partLookup()));
  expect(mocks.structured).toHaveBeenCalledTimes(1);
  expect(await response.json()).toMatchObject({
    kind: "abstention",
    message: "No authorized sources are available."
  });
  // The library read is still pinned to the manual source.
  expect(mocks.read.mock.calls[0]?.[1]).toEqual([
    "company",
    "manuals",
    true,
    5
  ]);
});

it("leaves the manual path untouched when no registry is configured", async () => {
  const handler = createReadHandler({
    ...baseOptions,
    manualSourceId: "manuals"
  });
  const response = await handler(request(partLookup()));
  expect(mocks.structured).not.toHaveBeenCalled();
  expect(await response.json()).toMatchObject({
    kind: "abstention",
    message: "No authorized sources are available."
  });
});

it("does not reach a source for a question the router sent to the index", async () => {
  const handler = createReadHandler({
    ...baseOptions,
    manualSourceId: "manuals",
    sources
  });
  await handler(
    request({ ...partLookup(), text: "torque spec for the gearbox" })
  );
  expect(mocks.structured).not.toHaveBeenCalled();
});

it("re-reads the binding before delivering a live-source answer", async () => {
  mocks.structured.mockResolvedValue({
    requestId: "request-1",
    kind: "results",
    evidence: [],
    claims: [],
    message: "",
    partial: false
  });
  identityStore.resolveHuman.mockResolvedValue({
    actorId: principal.actorId,
    bindingActive: false,
    userActive: true,
    membershipActive: true,
    capabilities: ["knowledge.read"]
  });
  const handler = createReadHandler({
    ...baseOptions,
    manualSourceId: "manuals",
    sources
  });
  expect((await handler(request(partLookup()))).status).toBe(503);
});
