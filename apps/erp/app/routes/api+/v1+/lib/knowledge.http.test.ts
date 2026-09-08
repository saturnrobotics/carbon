import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveItems: vi.fn(),
  client: { kind: "synthetic-client" }
}));

vi.mock("~/modules/account/account.service", () => ({}));
vi.mock("~/modules/accounting/accounting.ee.service", () => ({}));
vi.mock("~/modules/documents/documents.service", () => ({}));
vi.mock("~/modules/inventory/inventory.service", () => ({}));
vi.mock("~/modules/invoicing/invoicing.service", () => ({}));
vi.mock("~/modules/items/items.service", () => ({}));
vi.mock("~/modules/knowledge/knowledge.service", () => ({
  resolveItems: mocks.resolveItems
}));
vi.mock("~/modules/people/people.service", () => ({}));
vi.mock("~/modules/production/production.mcp.server", () => ({}));
vi.mock("~/modules/production/production.service", () => ({}));
vi.mock("~/modules/purchasing/purchasing.service", () => ({}));
vi.mock("~/modules/quality/quality.service", () => ({}));
vi.mock("~/modules/resources/resources.service", () => ({}));
vi.mock("~/modules/sales/sales.service", () => ({}));
vi.mock("~/modules/settings/settings.service", () => ({}));
vi.mock("~/modules/shared/shared.service", () => ({}));
vi.mock("~/modules/users/users.service", () => ({}));
vi.mock("~/services/database.server", () => ({
  getDatabaseClient: () => ({})
}));
vi.mock("./authenticate.server", () => ({
  resolveApiContext: () => ({
    client: mocks.client,
    userId: "usr_synthetic",
    companyId: "cmp_synthetic",
    companyGroupId: "grp_synthetic",
    authKind: "workforce",
    scopes: {},
    workforce: {
      allowedOperations: ["knowledge_resolveItems"],
      capabilities: ["knowledge.read"],
      permissions: {
        parts: {
          view: ["cmp_synthetic"],
          create: [],
          update: [],
          delete: []
        }
      },
      policyVersion: "identity-1:permission-1"
    }
  })
}));

import { action } from "../$";

describe("knowledge HTTP dispatch", () => {
  it("returns the projected item list rather than a Supabase builder", async () => {
    const item = {
      id: "item_synthetic",
      readableId: "SYN-100",
      readableIdWithRevision: "SYN-100-A",
      name: "Synthetic assembly",
      description: null,
      type: "Part",
      revision: "A",
      revisionStatus: "Production",
      mpn: "SYN-MPN-100",
      unitOfMeasureCode: "EA",
      active: true,
      updatedAt: null
    };
    mocks.resolveItems.mockResolvedValueOnce({ data: [item], error: null });

    const response = await action({
      request: new Request(
        "https://erp.example.com/api/v1/knowledge/resolveItems",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ search: "SYN-100", limit: 5 })
        }
      ),
      params: {},
      context: {}
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [item], count: null });
    expect(mocks.resolveItems).toHaveBeenCalledWith(
      mocks.client,
      "cmp_synthetic",
      "SYN-100",
      5
    );
  });
});
