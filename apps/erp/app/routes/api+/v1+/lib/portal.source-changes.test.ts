import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  acknowledge: vi.fn(),
  versions: vi.fn(),
  projections: vi.fn(),
  activeSource: vi.fn(),
  verify: vi.fn(),
  db: { kind: "synthetic-kysely" }
}));

vi.mock("~/modules/portal/portal.changes.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/modules/portal/portal.changes.server")
  >()),
  claimPortalSourceChanges: mocks.claim,
  acknowledgePortalSourceChanges: mocks.acknowledge,
  listPortalSourceEntityVersions: mocks.versions,
  getPortalSourceEntityProjections: mocks.projections,
  isActiveCarbonPortalSource: mocks.activeSource
}));
vi.mock("@carbon/portal/machine-identity.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@carbon/portal/machine-identity.server")
  >()),
  verifyMachineRequest: mocks.verify
}));
vi.mock("~/services/database.server", () => ({
  getDatabaseClient: () => mocks.db
}));

import { action, loader } from "../portal.source-changes";

const configuration = JSON.stringify({
  audience: "https://erp.example",
  callers: [
    {
      subject: "indexer@example.iam.gserviceaccount.com",
      callerId: "indexer-a",
      companyIds: ["cmp_synthetic"],
      sourceIds: ["ksrc_synthetic"],
      capabilities: ["source.changes.read"]
    }
  ]
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return action({
    request: new Request("https://erp.example/api/v1/portal/source-changes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer service-token",
        "x-portal-company-id": "cmp_synthetic",
        ...headers
      },
      body: JSON.stringify(body)
    }),
    params: {},
    context: {}
  } as never);
}

beforeEach(() => {
  process.env.PORTAL_MACHINE_CALLERS_JSON = configuration;
  mocks.claim.mockReset();
  mocks.acknowledge.mockReset();
  mocks.versions.mockReset();
  mocks.projections.mockReset();
  mocks.activeSource.mockReset().mockResolvedValue(true);
  mocks.verify.mockReset().mockResolvedValue({
    kind: "machine",
    callerId: "indexer-a",
    companyId: "cmp_synthetic",
    sourceIds: ["ksrc_synthetic"],
    policyVersion: "machine:indexer-a",
    capabilities: ["source.changes.read"]
  });
});
afterEach(() => {
  delete process.env.PORTAL_MACHINE_CALLERS_JSON;
});

describe("portal source-changes route", () => {
  it("claims for the verified machine's company only, never a body-supplied one", async () => {
    mocks.claim.mockResolvedValueOnce({
      items: [],
      observedAt: "2026-09-01T10:00:00Z",
      sourceRevision: "carbon:cmp_synthetic:2026-09-01T10:00:00Z",
      status: "complete"
    });
    const response = await post({
      action: "claim",
      sourceId: "ksrc_synthetic",
      workerId: "worker-1",
      limit: 50
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "ksrc_synthetic",
        capability: "source.changes.read"
      })
    );
    expect(mocks.activeSource).toHaveBeenCalledWith(
      mocks.db,
      "cmp_synthetic",
      "ksrc_synthetic"
    );
    expect(mocks.claim).toHaveBeenCalledWith(mocks.db, {
      companyId: "cmp_synthetic",
      workerId: "worker-1",
      limit: 50
    });
    expect(await response.json()).toMatchObject({ status: "complete" });
  });

  it("dispatches acknowledge, versions and projections with the company from the principal", async () => {
    mocks.acknowledge.mockResolvedValueOnce({ acknowledged: ["kso_one"] });
    mocks.versions.mockResolvedValueOnce({ items: [], status: "complete" });
    mocks.projections.mockResolvedValueOnce({ items: [], status: "complete" });
    await post({
      action: "acknowledge",
      sourceId: "ksrc_synthetic",
      workerId: "worker-1",
      eventIds: ["kso_one"]
    });
    await post({
      action: "versions",
      sourceId: "ksrc_synthetic",
      entityType: "item",
      cursor: "item_a",
      limit: 100
    });
    await post({
      action: "projections",
      sourceId: "ksrc_synthetic",
      entityType: "receipt",
      entityIds: ["rcv_a"]
    });
    expect(mocks.acknowledge).toHaveBeenCalledWith(mocks.db, {
      companyId: "cmp_synthetic",
      workerId: "worker-1",
      eventIds: ["kso_one"]
    });
    expect(mocks.versions).toHaveBeenCalledWith(mocks.db, {
      companyId: "cmp_synthetic",
      entityType: "item",
      cursor: "item_a",
      limit: 100
    });
    expect(mocks.projections).toHaveBeenCalledWith(mocks.db, {
      companyId: "cmp_synthetic",
      entityType: "receipt",
      entityIds: ["rcv_a"]
    });
  });

  it("refuses an unverified machine, an unknown source and a malformed body without touching the database", async () => {
    mocks.verify.mockRejectedValueOnce(
      new Error("unauthorized machine request")
    );
    const unauthorized = await post({
      action: "claim",
      sourceId: "ksrc_synthetic",
      workerId: "worker-1",
      limit: 1
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

    mocks.activeSource.mockResolvedValueOnce(false);
    const missing = await post({
      action: "claim",
      sourceId: "ksrc_other",
      workerId: "worker-1",
      limit: 1
    });
    expect(missing.status).toBe(404);

    const malformed = await post({ action: "claim", limit: 1000 });
    expect(malformed.status).toBe(422);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("is closed when no machine callers are configured and rejects GET", async () => {
    delete process.env.PORTAL_MACHINE_CALLERS_JSON;
    const closed = await post({
      action: "claim",
      sourceId: "ksrc_synthetic",
      workerId: "worker-1",
      limit: 1
    });
    expect(closed.status).toBe(503);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(loader().status).toBe(405);
  });
});
