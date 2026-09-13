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
  ["bounded-result-truncated", "more receipt lines than one read returns"],
  ["ambiguous-lot", "a receipt line recording more than one lot"],
  [
    "missing-identity,invalid-posting-date",
    "a receipt line whose posting date could not be read"
  ],
  // A reason this build does not recognise, and none at all, both leave the
  // candidate set unaccounted for — neither may be waved through.
  ["missing-ledger", "missing-ledger"],
  ["", "the source did not say what was missing"]
])("cannot repair incomplete source data (%s) with a manual link", async (reason, named) => {
  mocks.reason = reason;
  const result = await resolveRecentManual(options);
  expect(result.kind).toBe("abstention");
  expect(result.partial).toBe(true);
  // The answer names what could not be determined rather than reading as an
  // outage or an empty corpus.
  expect(result.message).toContain(named);
  expect(result.message).toContain("Review the receipt in Carbon");
  expect(mocks.read).not.toHaveBeenCalled();
});
