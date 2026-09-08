import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reason: "missing-identity",
  read: vi.fn(),
  source: vi.fn()
}));
vi.mock("@carbon/knowledge/sources/registry.server", () => ({
  createSourceRegistry: () => ({
    carbon: () => ({
      searchItems: async () => [{ id: "motor", name: "NEMA 34 motor" }],
      recentReceiptItems: async () => ({
        status: "partial",
        incompleteReason: mocks.reason,
        items: [
          {
            id: "receipt",
            itemId: "motor",
            revision: "A",
            manufacturer: "",
            mpn: "M34",
            receivedAt: "2026-09-01T00:00:00Z",
            quantity: "1",
            reversedQuantity: "0",
            posted: true,
            voided: false,
            missingIdentityFields: ["manufacturer"]
          }
        ]
      })
    })
  })
}));
vi.mock("@carbon/knowledge/database.server", () => ({
  withKnowledgeTransaction: async (
    _pool: unknown,
    _identity: unknown,
    _mode: unknown,
    operation: (client: unknown) => unknown
  ) => operation({ query: mocks.read })
}));
vi.mock("@carbon/knowledge/retrieval/evidence", () => ({
  assembleEvidence: async () => [{ id: "chunk-manual" }]
}));
vi.mock("./drive-access.server", () => ({
  createDriveAccessChecker: () => async () => true
}));

import { resolveRecentManual } from "./manual.server";

const options = {
  request: new Request("https://query.example"),
  query: {
    requestId: "r",
    text: "pull up the manual for the NEMA 34 motor we recently got",
    mode: "locate",
    locale: "en"
  },
  identity: {
    principal: { companyId: "company", actorId: "actor", policyVersion: "p" }
  },
  pool: {},
  configuration: {
    version: 1,
    sources: [
      {
        id: "carbon",
        kind: "carbon",
        origin: "https://carbon.example",
        audience: "carbon"
      }
    ]
  },
  origin: "https://portal.example",
  sourceIds: ["carbon"]
} as never;
beforeEach(() => {
  mocks.reason = "missing-identity";
  mocks.read.mockReset();
  mocks.read
    .mockResolvedValueOnce({
      rows: [
        {
          sourceEntityId: "motor",
          documentVersionId: "manual-v1",
          applicability: {
            revision: "A",
            manufacturer: "Manufacturer",
            mpn: "M34"
          }
        }
      ]
    })
    .mockResolvedValueOnce({ rows: [{ id: "chunk-manual" }] });
});
it("resolves a missing manufacturer only through the exact human-verified item/revision/MPN link", async () => {
  const result = await resolveRecentManual(options);
  expect(result.kind).toBe("results");
  expect(result.evidence).toHaveLength(1);
});
it.each([
  "missing-ledger",
  "bounded-result-truncated",
  "missing-identity,missing-ledger",
  ""
])("cannot repair incomplete source data (%s) with a manual link", async (reason) => {
  mocks.reason = reason;
  const result = await resolveRecentManual(options);
  expect(result.kind).toBe("abstention");
  expect(result.partial).toBe(true);
  expect(mocks.read).not.toHaveBeenCalled();
});
