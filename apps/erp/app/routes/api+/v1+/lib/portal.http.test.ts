import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveItems: vi.fn(),
  client: { kind: "synthetic-client" },
  assurance: {
    required: false,
    satisfied: true,
    method: "carbon-mfa" as "carbon-mfa" | "workspace-equivalent"
  }
}));

vi.mock("~/modules/account/account.service", () => ({}));
vi.mock("~/modules/accounting/accounting.ee.service", () => ({}));
vi.mock("~/modules/documents/documents.service", () => ({}));
vi.mock("~/modules/inventory/inventory.service", () => ({}));
vi.mock("~/modules/invoicing/invoicing.service", () => ({}));
vi.mock("~/modules/items/items.service", () => ({}));
vi.mock("~/modules/portal/portal.service", () => ({
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
      allowedOperations: ["portal_resolveItems"],
      capabilities: ["portal.read"],
      permissions: {
        parts: {
          view: ["cmp_synthetic"],
          create: [],
          update: [],
          delete: []
        }
      },
      policyVersion: "identity-1:permission-1",
      assurance: mocks.assurance
    }
  })
}));

import { action } from "../$";

function resolveItemsRequest() {
  return new Request("https://erp.example.com/api/v1/portal/resolveItems", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ search: "SYN-100", limit: 5 })
  });
}

describe("portal HTTP dispatch", () => {
  it("denies a required, unsatisfied assurance before any service function runs", async () => {
    mocks.assurance = {
      required: true,
      satisfied: false,
      method: "carbon-mfa"
    };
    try {
      const response = await action({
        request: resolveItemsRequest(),
        params: {},
        context: {}
      } as never);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "FORBIDDEN",
        status: 403,
        data: { code: "step_up_required", method: "carbon-mfa" }
      });
      expect(mocks.resolveItems).not.toHaveBeenCalled();
    } finally {
      mocks.assurance = {
        required: false,
        satisfied: true,
        method: "carbon-mfa"
      };
    }
  });

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
        "https://erp.example.com/api/v1/portal/resolveItems",
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
