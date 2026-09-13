import { afterEach, expect, it, vi } from "vitest";

const query = vi.hoisted(() =>
  vi.fn(async () => ({ rows: [{ id: "carbon", kind: "carbon" }] }))
);
vi.mock("@carbon/knowledge/database.server", () => ({
  withKnowledgeTransaction: async (
    _pool: unknown,
    _principal: unknown,
    _mode: unknown,
    operation: (client: unknown) => unknown
  ) => operation({ query })
}));
vi.mock("@carbon/knowledge/identity.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@carbon/knowledge/identity.server")
  >()),
  createWorkforceForwardingHeaders: async () =>
    new Headers({
      authorization: "Bearer fresh-service-token",
      "x-portal-user-evidence": "verified-user-token"
    })
}));

import { outcomeResult, structuredSourceQuery } from "./sources.server";

const configuration = {
  version: 1 as const,
  sources: [
    {
      id: "carbon",
      kind: "carbon" as const,
      origin: "https://erp.example",
      audience: "erp-audience"
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
  accessLevels: [],
  assurance: { mode: "carbon-mfa" as const }
};
const motor = (id: string, mpn: string) => ({
  id,
  readableId: id.toUpperCase(),
  readableIdWithRevision: `${id.toUpperCase()}-B`,
  name: `NEMA 34 motor ${mpn}`,
  description: null,
  type: "Part",
  revision: "B",
  revisionStatus: "Production",
  mpn,
  unitOfMeasureCode: "EA",
  active: true,
  updatedAt: null
});
const base = {
  request: new Request("https://query.example"),
  identity,
  pool: {} as never,
  configuration,
  origin: "https://portal.example",
  businessTimezone: "America/Chicago"
};
afterEach(() => vi.unstubAllGlobals());

it("locates similar motor variants as distinct current rows with Carbon deep links", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      results: [motor("mtr-34-60", "M-34-60"), motor("mtr-34-80", "M-34-80")],
      count: null
    })
  );
  const result = await structuredSourceQuery({
    ...base,
    query: {
      requestId: "q1",
      text: "find the part NEMA 34",
      mode: "locate",
      locale: "en"
    }
  });
  expect(result).toMatchObject({ kind: "results", partial: false });
  expect(result?.evidence.map((item) => item.entityId)).toEqual([
    "mtr-34-60",
    "mtr-34-80"
  ]);
  expect(result?.evidence[0]).toMatchObject({
    sourceUri: "https://erp.example/x/part/mtr-34-60",
    freshness: "current"
  });
  expect(result?.evidence[0]?.excerpt).toContain("mpn: M-34-60");
  expect(result?.evidence[0]?.excerpt).not.toContain("M-34-80");
});

it("reports a Carbon outage or denial instead of an authoritative empty result", async () => {
  vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
  const outage = await structuredSourceQuery({
    ...base,
    query: {
      requestId: "q2",
      text: "find part NEMA 34",
      mode: "locate",
      locale: "en"
    }
  });
  expect(outage).toMatchObject({
    kind: "abstention",
    partial: true,
    message: expect.stringContaining("not an empty result")
  });
  vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
  const denied = await structuredSourceQuery({
    ...base,
    query: {
      requestId: "q3",
      text: "find part NEMA 34",
      mode: "locate",
      locale: "en"
    }
  });
  expect(denied).toMatchObject({
    kind: "abstention",
    partial: true,
    message: "This source did not authorize the request."
  });
  expect(JSON.stringify(denied)).not.toContain("403");
});

it("renders ambiguity as a bounded clarification that never counts hidden candidates", () => {
  const result = outcomeResult(
    {
      requestId: "q4",
      kind: "abstention",
      evidence: [],
      claims: [],
      message: "",
      partial: false
    },
    {
      kind: "ambiguous",
      choices: [
        { id: "mtr-34-60", label: "NEMA 34 motor M-34-60" },
        { id: "mtr-34-80", label: "NEMA 34 motor M-34-80" }
      ],
      moreHidden: true
    }
  );
  expect(result).toMatchObject({
    kind: "clarification",
    choices: [{ id: "mtr-34-60" }, { id: "mtr-34-80" }]
  });
  expect(result?.message).toContain("some matches are not shown");
  expect(result?.message).not.toMatch(/\d/);
});
