// The API and MCP lock (HQ plan 0006B): driven through the REAL router, gate
// middleware and callOperation bridge that MCP tools and /api/v1 share; only the
// service registry, the database and the authenticator are replaced.
import { call, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeStatusDatabase, MANAGED } from "./saturn.test-db";

const h = vi.hoisted(() => ({
  database: null as unknown,
  users: {
    insertEmployeeType: vi.fn(async () => ({
      data: { id: "et_1" },
      error: null
    })),
    upsertEmployeeType: vi.fn(async () => ({
      data: { id: "et_1" },
      error: null
    })),
    upsertEmployeeTypePermissions: vi.fn(async () => ({
      data: null,
      error: null
    })),
    deleteEmployeeType: vi.fn(async () => ({ data: null, error: null })),
    getEmployeeTypes: vi.fn(async () => ({ data: [], count: 0, error: null }))
  }
}));

vi.mock("~/modules/account/account.service", () => ({}));
vi.mock("~/modules/accounting/accounting.ee.service", () => ({}));
vi.mock("~/modules/documents/documents.service", () => ({}));
vi.mock("~/modules/inventory/inventory.service", () => ({}));
vi.mock("~/modules/invoicing/invoicing.service", () => ({}));
vi.mock("~/modules/items/items.service", () => ({}));
vi.mock("~/modules/portal/portal.service", () => ({}));
vi.mock("~/modules/portal/portal.mcp.server", () => ({}));
vi.mock("~/modules/people/people.service", () => ({}));
vi.mock("~/modules/production/production.mcp.server", () => ({}));
vi.mock("~/modules/production/production.service", () => ({}));
vi.mock("~/modules/purchasing/purchasing.service", () => ({}));
vi.mock("~/modules/quality/quality.service", () => ({}));
vi.mock("~/modules/resources/resources.service", () => ({}));
vi.mock("~/modules/sales/sales.service", () => ({}));
vi.mock("~/modules/settings/settings.service", () => ({}));
vi.mock("~/modules/shared/shared.service", () => ({}));
vi.mock("~/modules/users/users.service", () => h.users);
vi.mock("~/services/database.server", () => ({
  getDatabaseClient: () => h.database
}));
vi.mock("~/routes/api+/v1+/lib/authenticate.server", () => ({
  resolveApiContext: () => null
}));

import type { AuthedContext } from "~/routes/api+/v1+/lib/base.server";
import { callOperation } from "~/routes/api+/v1+/lib/call.server";
import { router } from "~/routes/api+/v1+/lib/router.server";

const COMPANY = "cmp_alpha";
const context = (
  authKind: AuthedContext["authKind"] = "oauth"
): AuthedContext => ({
  client: {} as AuthedContext["client"],
  userId: "usr_synthetic",
  companyId: COMPANY,
  companyGroupId: "grp_alpha",
  authKind,
  scopes: {
    users_create: [COMPANY],
    users_update: [COMPANY],
    users_delete: [COMPANY]
  }
});

const LOCKED = [
  [
    "users_upsertEmployeeTypePermissions",
    { employeeTypeId: "et_1", permissions: [] }
  ],
  ["users_upsertEmployeeType", { employeeType: { id: "et_1", name: "Ops" } }],
  ["users_insertEmployeeType", { employeeType: { name: "Ops" } }],
  ["users_deleteEmployeeType", { employeeTypeId: "et_1" }]
] as const;

let fake: ReturnType<typeof fakeStatusDatabase>;
beforeEach(() => {
  fake = fakeStatusDatabase();
  h.database = fake.db;
  for (const fn of Object.values(h.users)) fn.mockClear();
});

const serviceCalls = () =>
  Object.values(h.users).reduce((n, fn) => n + fn.mock.calls.length, 0);

describe("MCP and API permission tools", () => {
  it.each(
    LOCKED
  )("%s is refused while HQ manages permissions", async (name, args) => {
    fake.state.status = MANAGED;
    const result = await callOperation(name, context(), { ...args });
    expect(result).toMatchObject({ success: false });
    expect(result.success ? "" : result.error).toContain(
      "Carbon permissions are managed in HQ"
    );
    expect(serviceCalls()).toBe(0);
  });

  it.each(
    LOCKED
  )("%s answers FORBIDDEN over HTTP while managed", async (name, args) => {
    fake.state.status = MANAGED;
    const id = name.replace(/^users_/, "");
    const procedure = router.users?.[id];
    expect(procedure, name).toBeTruthy();
    const error = await call(
      procedure!,
      { ...args },
      { context: context("api-key") }
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
    expect(serviceCalls()).toBe(0);
  });

  it("reaches the service before cutover", async () => {
    const result = await callOperation(
      "users_upsertEmployeeTypePermissions",
      context(),
      {
        employeeTypeId: "et_1",
        permissions: []
      }
    );
    expect(result).toMatchObject({ success: true });
    expect(h.users.upsertEmployeeTypePermissions).toHaveBeenCalledTimes(1);
  });

  it("leaves reads alone while managed", async () => {
    fake.state.status = MANAGED;
    const result = await callOperation("users_getEmployeeTypes", context(), {});
    expect(result).toMatchObject({ success: true });
    expect(h.users.getEmployeeTypes).toHaveBeenCalledTimes(1);
    expect(fake.state.queries).toEqual([]);
  });
});
