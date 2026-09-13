// The canonical read gate for the knowledge module, driven through the REAL
// router, the real gate middleware, the real callOperation bridge and the real
// route action; only the service registry and the authenticator are replaced.
//
// What is pinned: one allowlist covers every generated knowledge operation;
// every non-workforce caller kind is answered NOT_FOUND on every path (HTTP,
// server-side call, callOperation); a workforce caller is refused across a
// company boundary, without the capability, and for an operation its caller
// registry does not name; and the discovery surfaces do not disclose the module.

import type { ManifestEntry } from "@carbon/api";
import { call, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  knowledge: {
    resolveItems: vi.fn(),
    getItemIdentity: vi.fn(),
    getDocumentReferences: vi.fn(),
    getRecentReceipts: vi.fn(),
    getRecentReceiptItems: vi.fn(),
    getPurchaseStatus: vi.fn(),
    getItemSupplierPricing: vi.fn()
  },
  createProcurementDraft: vi.fn(),
  context: null as unknown
}));

vi.mock("~/modules/account/account.service", () => ({}));
vi.mock("~/modules/accounting/accounting.ee.service", () => ({}));
vi.mock("~/modules/documents/documents.service", () => ({}));
vi.mock("~/modules/inventory/inventory.service", () => ({}));
vi.mock("~/modules/invoicing/invoicing.service", () => ({}));
vi.mock("~/modules/items/items.service", () => ({}));
vi.mock("~/modules/knowledge/knowledge.service", () => mocks.knowledge);
vi.mock("~/modules/knowledge/knowledge.mcp.server", () => ({
  createProcurementDraft: mocks.createProcurementDraft
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
  resolveApiContext: () => mocks.context
}));

import {
  isKnowledgeOperation,
  KNOWLEDGE_OPERATIONS,
  knowledgeCapabilityFor
} from "~/modules/knowledge/knowledge.server";
import { createCatalogSearch } from "../../mcp+/lib/catalog-search";
import { action } from "../$";
import { loader as openApiLoader } from "../openapi[.]json";
import {
  type AuthedContext,
  assertWorkforceAuthorization
} from "./base.server";
import { callOperation } from "./call.server";
import {
  DISCLOSED_OPERATIONS,
  disclosedOperationsByName,
  OPERATIONS,
  operationId,
  operationsByName
} from "./operations.server";
import { disclosedRouter, router } from "./router.server";

const knowledgeOperations = OPERATIONS.filter(isKnowledgeOperation);
const COMPANY = "cmp_alpha";

const fullPermissions = {
  parts: { view: [COMPANY], create: [], update: [], delete: [] },
  inventory: { view: [COMPANY], create: [], update: [], delete: [] },
  purchasing: { view: [COMPANY], create: [COMPANY], update: [], delete: [] }
};

function context(overrides: Partial<AuthedContext> = {}): AuthedContext {
  return {
    client: {} as AuthedContext["client"],
    userId: "usr_synthetic",
    companyId: COMPANY,
    companyGroupId: "grp_alpha",
    authKind: "oauth",
    scopes: {},
    ...overrides
  };
}

function workforce(
  overrides: Partial<NonNullable<AuthedContext["workforce"]>> = {}
): AuthedContext {
  return context({
    authKind: "workforce",
    workforce: {
      allowedOperations: Object.keys(KNOWLEDGE_OPERATIONS),
      capabilities: [...new Set(Object.values(KNOWLEDGE_OPERATIONS))],
      permissions: fullPermissions,
      policyVersion: "identity-1:permission-1",
      assurance: { required: false, satisfied: true, method: "carbon-mfa" },
      ...overrides
    }
  });
}

/** The smallest body that satisfies an operation's published input schema, so a
 *  refusal observed here is the gate's and not input validation's. */
function minimalInput(schema: unknown): unknown {
  const node = (schema ?? {}) as {
    type?: string | string[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
  };
  const type = Array.isArray(node.type)
    ? node.type.find((t) => t !== "null")
    : node.type;
  switch (type) {
    case "string":
      return "synthetic";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [minimalInput(node.items)];
    default:
      return Object.fromEntries(
        (node.required ?? []).map((key) => [
          key,
          minimalInput(node.properties?.[key])
        ])
      );
  }
}

async function rejection(
  promise: Promise<unknown>
): Promise<ORPCError<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

function serviceCalls(): number {
  return [
    ...Object.values(mocks.knowledge),
    mocks.createProcurementDraft
  ].reduce((count, fn) => count + fn.mock.calls.length, 0);
}

describe("one allowlist", () => {
  it("covers every generated knowledge operation with a capability", () => {
    expect(knowledgeOperations.length).toBe(8);
    for (const op of knowledgeOperations) {
      expect(knowledgeCapabilityFor(op.name), op.name).toBeTruthy();
    }
  });

  it("names no operation the manifest does not publish", () => {
    for (const name of Object.keys(KNOWLEDGE_OPERATIONS)) {
      expect(operationsByName.get(name)?.module, name).toBe("knowledge");
    }
  });

  it("gives pricing its own capability and the purchasing view permission", () => {
    expect(knowledgeCapabilityFor("knowledge_getItemSupplierPricing")).toBe(
      "knowledge.read.pricing"
    );
    expect(
      operationsByName.get("knowledge_getItemSupplierPricing")?.permission
    ).toEqual({ module: "purchasing", actions: ["view"] });
  });
});

describe("non-workforce callers", () => {
  it.each([
    "api-key",
    "oauth",
    "session"
  ] as const)("%s receives NOT_FOUND for every knowledge operation via the router", async (authKind) => {
    const ctx = context({
      authKind,
      scopes: { parts_view: [COMPANY], purchasing_view: [COMPANY] }
    });
    for (const op of knowledgeOperations) {
      const error = await rejection(
        call(router.knowledge[operationId(op)], minimalInput(op.schema), {
          context: ctx
        })
      );
      expect(error.code, op.name).toBe("NOT_FOUND");
    }
    expect(serviceCalls()).toBe(0);
  });

  it("is refused by callOperation (the MCP and agent path) before any service runs", async () => {
    for (const op of knowledgeOperations) {
      const result = await callOperation(
        op.name,
        context({ authKind: "oauth" }),
        minimalInput(op.schema) as Record<string, unknown>
      );
      expect(result.success, op.name).toBe(false);
    }
    expect(serviceCalls()).toBe(0);
  });
});

describe("workforce callers", () => {
  const pricing = operationsByName.get(
    "knowledge_getItemSupplierPricing"
  ) as ManifestEntry;
  const identity = operationsByName.get(
    "knowledge_getItemIdentity"
  ) as ManifestEntry;

  it("is refused when the user's permissions name a different company", async () => {
    const ctx = workforce({
      permissions: {
        parts: { view: ["cmp_beta"], create: [], update: [], delete: [] }
      }
    });
    expect(() => assertWorkforceAuthorization(ctx, identity)).toThrow(
      /permission/
    );
    const error = await rejection(
      call(
        router.knowledge.getItemIdentity,
        { itemId: "item_x" },
        { context: ctx }
      )
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(mocks.knowledge.getItemIdentity).not.toHaveBeenCalled();
  });

  it("requires the pricing capability for the pricing read", () => {
    const readOnly = workforce({ capabilities: ["knowledge.read"] });
    expect(() => assertWorkforceAuthorization(readOnly, pricing)).toThrow();
    expect(() =>
      assertWorkforceAuthorization(
        workforce({ capabilities: ["knowledge.read.pricing"] }),
        pricing
      )
    ).not.toThrow();
  });

  it("requires purchasing view for the pricing read even with the capability", () => {
    const ctx = workforce({
      permissions: {
        ...fullPermissions,
        purchasing: { view: [], create: [COMPANY], update: [], delete: [] }
      }
    });
    expect(() => assertWorkforceAuthorization(ctx, pricing)).toThrow(
      /permission/
    );
  });

  it("is refused for an operation the module does not list", () => {
    expect(() =>
      assertWorkforceAuthorization(workforce(), {
        ...identity,
        name: "knowledge_getItemCost"
      })
    ).toThrow();
  });

  it("reaches the service with the caller's client and company once authorized", async () => {
    mocks.knowledge.getItemSupplierPricing.mockResolvedValueOnce({
      data: [],
      error: null
    });
    const ctx = workforce();
    const body = await call(
      router.knowledge.getItemSupplierPricing,
      { itemId: "item_x" },
      { context: ctx }
    );
    expect(body).toEqual({ results: [], count: null });
    expect(mocks.knowledge.getItemSupplierPricing).toHaveBeenCalledWith(
      ctx.client,
      "item_x",
      COMPANY,
      undefined
    );
  });

  it("answers 403 over real HTTP when a read-only caller invokes the procurement write", async () => {
    mocks.context = workforce({
      allowedOperations: Object.keys(KNOWLEDGE_OPERATIONS).filter(
        (name) => name !== "knowledge_createProcurementDraft"
      ),
      capabilities: ["knowledge.read"]
    });
    const response = await action({
      request: new Request(
        "https://erp.example.com/api/v1/knowledge/createProcurementDraft",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ args: {} })
        }
      ),
      params: {},
      context: {}
    } as never);

    expect(response.status).toBe(403);
    expect(mocks.createProcurementDraft).not.toHaveBeenCalled();
  });
});

describe("disclosure", () => {
  it("keeps knowledge operations in the manifest but out of the disclosed set", () => {
    expect(OPERATIONS.length - DISCLOSED_OPERATIONS.length).toBe(
      knowledgeOperations.length
    );
    for (const op of knowledgeOperations) {
      expect(disclosedOperationsByName.has(op.name), op.name).toBe(false);
      expect(router.knowledge[operationId(op)], op.name).toBeDefined();
    }
    expect(disclosedRouter.knowledge).toBeUndefined();
  });

  it("search_tools cannot find them by module, name or query", async () => {
    const catalog = createCatalogSearch(OPERATIONS);
    expect(catalog.moduleNames).not.toContain("knowledge");
    expect(catalog.totalTools).toBe(DISCLOSED_OPERATIONS.length);
    const byModule = await catalog.search({
      module: "knowledge",
      limit: 20,
      offset: 0
    });
    expect(byModule.total).toBe(0);
    const byQuery = await catalog.search({
      query: "knowledge_getItemSupplierPricing supplier pricing",
      limit: 50,
      offset: 0
    });
    expect(byQuery.matches.map((m) => m.module)).not.toContain("knowledge");
  });

  it("the public OpenAPI document has no knowledge path or tag", async () => {
    const spec = (await (await openApiLoader()).json()) as {
      paths: Record<string, unknown>;
      tags?: Array<{ name: string }>;
    };
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBe(DISCLOSED_OPERATIONS.length);
    expect(paths.some((path) => path.startsWith("/knowledge/"))).toBe(false);
    expect(JSON.stringify(spec)).not.toContain("knowledge_");
  });
});
