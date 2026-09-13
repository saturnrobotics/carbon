import { randomUUID } from "node:crypto";
import type { Database } from "@carbon/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectFieldNames } from "~/routes/api+/mcp+/lib/catalog-search";
import toolMetadata from "~/routes/api+/mcp+/lib/tool-metadata.json";
import {
  getDocumentReferencesValidator,
  getItemIdentityValidator,
  getItemSupplierPricingValidator,
  getPurchaseStatusValidator,
  getRecentReceiptItemsValidator,
  getRecentReceiptsValidator,
  resolveItemsValidator
} from "./portal.models";
import { PORTAL_OPERATIONS } from "./portal.server";
import { getItemSupplierPricing, resolveItems } from "./portal.service";

describe("portal read request bounds", () => {
  it("accepts the reviewed bounded operation inputs", () => {
    expect(
      resolveItemsValidator.parse({ search: "SYN-100 / A", limit: 20 })
    ).toEqual({
      search: "SYN-100 / A",
      limit: 20
    });
    expect(getRecentReceiptsValidator.parse({ limit: 50 })).toEqual({
      limit: 50
    });
    expect(
      getRecentReceiptItemsValidator.parse({
        itemIds: ["item_one", "item_two"],
        limit: 20
      })
    ).toEqual({ itemIds: ["item_one", "item_two"], limit: 20 });
    expect(
      getItemIdentityValidator.parse({ itemId: "item_synthetic" })
    ).toBeTruthy();
    expect(
      getDocumentReferencesValidator.parse({ itemId: "item_synthetic" })
    ).toBeTruthy();
    expect(
      getPurchaseStatusValidator.parse({ purchaseOrderId: "PO-SYN-1" })
    ).toBeTruthy();
    expect(
      getItemSupplierPricingValidator.parse({
        itemId: "item_synthetic",
        supplierId: "supplier_synthetic"
      })
    ).toEqual({ itemId: "item_synthetic", supplierId: "supplier_synthetic" });
    expect(
      getItemSupplierPricingValidator.parse({ itemId: "item_synthetic" })
    ).toEqual({ itemId: "item_synthetic" });
  });

  it("rejects unbounded or PostgREST-control input", () => {
    expect(() =>
      resolveItemsValidator.parse({ search: "x),companyId.neq.y", limit: 51 })
    ).toThrow();
    expect(() => getRecentReceiptsValidator.parse({ limit: 0 })).toThrow();
    expect(() =>
      getRecentReceiptItemsValidator.parse({
        itemIds: Array.from({ length: 51 }, (_, index) => `item_${index}`)
      })
    ).toThrow();
    expect(() =>
      getPurchaseStatusValidator.parse({
        purchaseOrderId: "PO-1,status.neq.Draft",
        actorId: "forged"
      })
    ).toThrow();
    expect(() =>
      getItemIdentityValidator.parse({
        itemId: "item_synthetic",
        companyId: "forged"
      })
    ).toThrow();
    expect(() =>
      getItemSupplierPricingValidator.parse({
        itemId: "item_synthetic",
        supplierId: "sup_x,companyId.neq.y"
      })
    ).toThrow();
  });
});

// The published contract is what a caller sees, so the restricted-field rule is
// asserted on the manifest's reflected response schemas rather than on the
// select strings: a projection change that leaks a price shows up here whether
// it came from a column list, an embed or a mapped return type.
describe("portal read outputs", () => {
  const responseFields = (name: string) => {
    const op = toolMetadata.tools.find((tool) => tool.name === name);
    if (!op) throw new Error(`${name} is not in the generated manifest`);
    return [...collectFieldNames(op.responseSchema)];
  };
  const identityReads = Object.keys(PORTAL_OPERATIONS).filter(
    (name) =>
      PORTAL_OPERATIONS[name as keyof typeof PORTAL_OPERATIONS] ===
      "portal.read"
  );

  it("keeps every price and cost field out of the six identity reads", () => {
    expect(identityReads).toHaveLength(6);
    for (const name of identityReads) {
      const fields = responseFields(name);
      expect(fields.length, name).toBeGreaterThan(0);
      expect(
        fields.filter((field) => /price|cost/i.test(field)),
        name
      ).toEqual([]);
    }
  });

  it("discloses money only through the pricing read, and only the agreed fields", () => {
    expect(responseFields("portal_getItemSupplierPricing").sort()).toEqual([
      "currencyCode",
      "supplierId",
      "supplierUnitPrice",
      "unitOfMeasureCode",
      "updatedAt"
    ]);
  });
});

// Against a DISPOSABLE local Supabase stack only (`crbn up --no-apps` in a
// throwaway worktree slot): the reads go through PostgREST under the actor's own
// row-level security, which a bare Postgres fixture cannot exercise. Skipped
// unless the stack is named explicitly; refused unless it is local and marked
// disposable, since the fixture commits rows and deletes them afterwards.
type DisposableStack = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
};

function disposableStack(): DisposableStack | null {
  const url = process.env.PORTAL_READ_TEST_SUPABASE_URL;
  const anonKey = process.env.PORTAL_READ_TEST_ANON_KEY;
  const serviceRoleKey = process.env.PORTAL_READ_TEST_SERVICE_ROLE_KEY;
  const jwtSecret = process.env.PORTAL_READ_TEST_JWT_SECRET;
  if (!url || !anonKey || !serviceRoleKey || !jwtSecret) return null;
  const { hostname } = new URL(url);
  if (
    process.env.PORTAL_READ_TEST_DISPOSABLE !== "1" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(hostname)
  ) {
    throw new Error(
      "Set PORTAL_READ_TEST_SUPABASE_URL to a local stack and PORTAL_READ_TEST_DISPOSABLE=1"
    );
  }
  return { url, anonKey, serviceRoleKey, jwtSecret };
}

const stack = disposableStack();

/** Fixture writes only: the table union makes the typed builder too deep to
 *  instantiate, and the rows are deleted again in `afterAll`. */
type RowWriter = {
  from(table: string): {
    insert(values: unknown): {
      select(columns: string): {
        single(): Promise<{
          data: unknown;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

type Fixture = {
  actorId: string;
  companyId: string;
  itemId: string;
  supplierId: string;
  otherCompanyId: string;
  otherItemId: string;
};

describe.skipIf(!stack)("portal reads under row-level security", () => {
  let serviceRole: SupabaseClient<Database>;
  let asActor: SupabaseClient<Database>;
  let fixture: Fixture;

  async function insert(
    table: keyof Database["public"]["Tables"],
    values: Record<string, unknown>
  ) {
    const { data, error } = await (serviceRole as unknown as RowWriter)
      .from(table)
      .insert(values)
      .select("id")
      .single();
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data as { id: string }).id;
  }

  beforeAll(async () => {
    if (!stack) throw new Error("no disposable stack configured");
    // The production client factories read their connection from @carbon/env at
    // module load, so the stack's values are installed before they are imported.
    process.env.SUPABASE_URL = stack.url;
    process.env.SUPABASE_API_URL = stack.url;
    process.env.SUPABASE_ANON_KEY = stack.anonKey;
    process.env.SUPABASE_SERVICE_ROLE_KEY = stack.serviceRoleKey;
    process.env.SUPABASE_JWT_SECRET = stack.jwtSecret;
    const { getCarbonServiceRole, getUserScopedClient } = await import(
      "@carbon/auth/client.server"
    );
    serviceRole = getCarbonServiceRole();

    const actorId = randomUUID();
    const suffix = actorId.slice(0, 8);
    await insert("user", { id: actorId, email: `${actorId}@example.com` });
    const companyId = await insert("company", {
      name: "Portal Read Fixture",
      baseCurrencyCode: "USD"
    });
    const otherCompanyId = await insert("company", {
      name: "Portal Read Fixture (other)",
      baseCurrencyCode: "EUR"
    });
    await serviceRole
      .from("userToCompany")
      .insert({ userId: actorId, companyId, role: "employee" })
      .throwOnError();
    await serviceRole
      .from("userPermission")
      .upsert({
        id: actorId,
        permissions: {
          parts_view: [companyId],
          purchasing_view: [companyId]
        }
      })
      .throwOnError();
    const supplierId = await insert("supplier", {
      companyId,
      name: "Synthetic Fasteners",
      currencyCode: "USD",
      createdBy: actorId
    });
    const itemId = await insert("item", {
      companyId,
      createdBy: actorId,
      readableId: `KRD-${suffix}`,
      name: "Synthetic bracket",
      type: "Part",
      itemTrackingType: "Inventory"
    });
    await insert("supplierPart", {
      companyId,
      createdBy: actorId,
      itemId,
      supplierId,
      unitPrice: 1.25,
      supplierUnitOfMeasureCode: "BOX"
    });
    const otherSupplierId = await insert("supplier", {
      companyId: otherCompanyId,
      name: "Other Fasteners",
      currencyCode: "EUR",
      createdBy: actorId
    });
    const otherItemId = await insert("item", {
      companyId: otherCompanyId,
      createdBy: actorId,
      readableId: `KRD-${suffix}`,
      name: "Other bracket",
      type: "Part",
      itemTrackingType: "Inventory"
    });
    await insert("supplierPart", {
      companyId: otherCompanyId,
      createdBy: actorId,
      itemId: otherItemId,
      supplierId: otherSupplierId,
      unitPrice: 9.99,
      supplierUnitOfMeasureCode: "EA"
    });
    fixture = {
      actorId,
      companyId,
      itemId,
      supplierId,
      otherCompanyId,
      otherItemId
    };
    asActor = await getUserScopedClient(actorId);
  });

  afterAll(async () => {
    if (!fixture) return;
    for (const companyId of [fixture.companyId, fixture.otherCompanyId]) {
      for (const table of ["supplierPart", "supplier", "item"] as const) {
        await serviceRole.from(table).delete().eq("companyId", companyId);
      }
      await serviceRole
        .from("userToCompany")
        .delete()
        .eq("companyId", companyId);
      await serviceRole.from("company").delete().eq("id", companyId);
    }
    await serviceRole.from("userPermission").delete().eq("id", fixture.actorId);
    await serviceRole.from("user").delete().eq("id", fixture.actorId);
  });

  it("returns the pricing projection, and nothing else, through the actor's client", async () => {
    const result = await getItemSupplierPricing(
      asActor,
      fixture.itemId,
      fixture.companyId
    );
    expect(result.error).toBeNull();
    expect(result.data).toEqual([
      {
        supplierId: fixture.supplierId,
        supplierUnitPrice: 1.25,
        currencyCode: "USD",
        unitOfMeasureCode: "BOX",
        updatedAt: null
      }
    ]);
  });

  it("filters by supplier when one is named", async () => {
    const other = await getItemSupplierPricing(
      asActor,
      fixture.itemId,
      fixture.companyId,
      "supplier_absent"
    );
    expect(other).toEqual({ data: [], error: null });
  });

  it("cannot read another company's pricing even when asked for it by id", async () => {
    const result = await getItemSupplierPricing(
      asActor,
      fixture.otherItemId,
      fixture.otherCompanyId
    );
    expect(result).toEqual({ data: [], error: null });
  });

  it("keeps the identity read free of money on real rows", async () => {
    const result = await resolveItems(asActor, fixture.companyId, "KRD-");
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1);
    const keys = Object.keys(result.data?.[0] ?? {});
    expect(keys.filter((key) => /price|cost/i.test(key))).toEqual([]);
    expect(result.data?.[0]?.id).toBe(fixture.itemId);
  });
});
