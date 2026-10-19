// The permission screens' hooks (HQ plan 0006B): while HQ manages Carbon's
// permissions every editing action stops before any write and points to HQ,
// and the screens render the read-only view; before cutover nothing changes.
// The real route modules and saturn.server run; their collaborators are stubs.
import type { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeStatusDatabase, MANAGED } from "./saturn.test-db";

const h = vi.hoisted(() => {
  const state = {
    database: null as unknown,
    loaderData: {} as Record<string, unknown>,
    writes: [] as string[],
    validated: [] as string[],
    /** A service call that writes, recorded by name. */
    write: (name: string) => async () => {
      state.writes.push(name);
      return { data: { id: "et_1" }, error: null };
    },
    /** A stand-in component identified by its displayName. */
    marker: (name: string) => Object.assign(() => null, { displayName: name })
  };
  return state;
});

vi.mock("@carbon/auth", () => ({
  assertIsPost: vi.fn(),
  error: (_error: unknown, message: string) => ({ success: false, message }),
  notFound: (message: string) => new Error(message),
  success: (message: string) => ({ success: true, message })
}));
vi.mock("@carbon/auth/auth.server", () => ({
  requirePermissions: vi.fn(async () => ({
    client: {},
    companyId: "cmp_1",
    userId: "usr_admin"
  }))
}));
vi.mock("@carbon/auth/client.server", () => ({
  getCarbonServiceRole: () => ({})
}));
vi.mock("@carbon/auth/session.server", () => ({
  flash: vi.fn(async (_request: Request, result: { message: string }) => ({
    headers: { "X-Flash": result.message }
  }))
}));
vi.mock("@carbon/form", () => ({
  validationError: () => "validation-error",
  validator: (schema: string) => ({
    validate: async () => {
      h.validated.push(schema);
      return { error: { fieldErrors: {} } };
    }
  })
}));
vi.mock("@carbon/jobs", () => ({ batchTrigger: h.write("batchTrigger") }));
vi.mock("@carbon/logger", () => ({ getLogger: () => ({ error: vi.fn() }) }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") })
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useLoaderData: () => h.loaderData,
  useNavigate: () => vi.fn(),
  useParams: () => ({ employeeTypeId: "et_1" })
}));
vi.mock("~/services/database.server", () => ({
  getDatabaseClient: () => h.database
}));
vi.mock("~/modules/saturn", () => ({
  AuthzManagedPermissions: h.marker("AuthzManagedPermissions")
}));
vi.mock("~/components/Modals", () => ({
  ConfirmDelete: h.marker("ConfirmDelete")
}));
vi.mock("~/modules/users", () => ({
  EmployeePermissionsForm: h.marker("EmployeePermissionsForm"),
  EmployeeTypeForm: h.marker("EmployeeTypeForm"),
  bulkPermissionsValidator: "bulkPermissionsValidator",
  employeeTypePermissionsValidator: { safeParse: () => ({ success: true }) },
  employeeTypeValidator: "employeeTypeValidator",
  employeeValidator: "employeeValidator",
  userPermissionsValidator: { safeParse: () => ({ success: true }) },
  deleteEmployeeType: h.write("deleteEmployeeType"),
  insertEmployeeType: h.write("insertEmployeeType"),
  upsertEmployeeType: h.write("upsertEmployeeType"),
  upsertEmployeeTypePermissions: h.write("upsertEmployeeTypePermissions"),
  getEmployeeType: vi.fn(async () => ({
    data: { id: "et_1", name: "Ops" },
    error: null
  })),
  getModules: vi.fn(async () => ({ data: [{ name: "Sales" }], error: null })),
  getPermissionsByEmployeeType: vi.fn(async () => ({ data: [], error: null }))
}));
vi.mock("~/modules/users/users.server", () => ({
  makeCompanyPermissionsFromEmployeeType: () => ({}),
  makeEmptyPermissionsFromModules: () => ({}),
  updateEmployee: h.write("updateEmployee")
}));
vi.mock("~/utils/path", () => ({
  getParams: () => "",
  path: {
    to: {
      deleteEmployeeType: (id: string) =>
        `/x/users/employee-types/delete/${id}`,
      employeeAccounts: "/x/users/employees",
      employeeTypes: "/x/users/employee-types"
    }
  }
}));
vi.mock("~/utils/react-query", () => ({
  getCompanyId: () => "cmp_1",
  invalidateUserSelectQueries: vi.fn()
}));

import * as bulkEdit from "~/routes/x+/users+/bulk-edit-permissions";
import * as editType from "~/routes/x+/users+/employee-types.$employeeTypeId";
import * as deleteType from "~/routes/x+/users+/employee-types.delete.$employeeTypeId";
import * as newType from "~/routes/x+/users+/employee-types.new";
import * as employee from "~/routes/x+/users+/employees.$employeeId";

type Args = Parameters<typeof employee.action>[0];
const args = (params: Record<string, string> = {}) =>
  ({
    request: new Request("https://erp.example.com/x/users", {
      method: "POST",
      body: new FormData()
    }),
    params,
    context: {}
  }) as unknown as Args;

let fake: ReturnType<typeof fakeStatusDatabase>;
beforeEach(() => {
  fake = fakeStatusDatabase();
  h.database = fake.db;
  h.writes = [];
  h.validated = [];
});

const actions = [
  ["employee permissions", employee.action, {}, "/x/users/employees"],
  ["bulk edit", bulkEdit.action, {}, "/x/users/employees"],
  ["edit employee type", editType.action, {}, "/x/users/employee-types"],
  ["new employee type", newType.action, {}, "/x/users/employee-types"],
  [
    "delete employee type",
    deleteType.action,
    { employeeTypeId: "et_1" },
    "/x/users/employee-types"
  ]
] as const;

describe("permission-editing actions", () => {
  it.each(
    actions
  )("%s stops before any write while HQ manages permissions", async (_name, action, params, list) => {
    fake.state.status = MANAGED;
    const thrown = await (action as (a: Args) => Promise<unknown>)(
      args(params)
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.headers.get("Location")).toBe(list);
    expect(response.headers.get("X-Flash")).toContain(
      "https://hq.example.com/admin/access"
    );
    expect(h.writes).toEqual([]);
    expect(h.validated).toEqual([]);
  });

  it.each(
    actions.slice(0, 4)
  )("%s runs as before until cutover", async (_name, action, params) => {
    await expect(
      (action as (a: Args) => Promise<unknown>)(args(params))
    ).resolves.toBe("validation-error");
    expect(h.validated).toHaveLength(1);
  });

  it("delete employee type runs as before until cutover", async () => {
    const thrown = await deleteType
      .action(args({ employeeTypeId: "et_1" }))
      .catch((e: unknown) => e);
    expect(h.writes).toEqual(["deleteEmployeeType"]);
    expect((thrown as Response).headers.get("X-Flash")).toBe(
      "Successfully deleted employee type"
    );
  });
});

describe("permission screens", () => {
  it("show the read-only HQ view for an employee type while managed", async () => {
    fake.state.status = MANAGED;
    h.loaderData = await editType.loader(args({ employeeTypeId: "et_1" }));
    expect(h.loaderData.authz).toEqual({
      managed: true,
      accessUrl: "https://hq.example.com/admin/access"
    });
    const view = editType.default() as ReturnType<typeof createElement>;
    expect((view.type as { displayName?: string }).displayName).toBe(
      "AuthzManagedPermissions"
    );
    expect(view.props).toMatchObject({
      title: "Ops",
      accessUrl: "https://hq.example.com/admin/access"
    });
  });

  it("show the editor before cutover", async () => {
    h.loaderData = await editType.loader(args({ employeeTypeId: "et_1" }));
    expect(h.loaderData.authz).toEqual({ managed: false, accessUrl: null });
    const view = editType.default() as ReturnType<typeof createElement>;
    expect((view.type as { displayName?: string }).displayName).toBe(
      "EmployeeTypeForm"
    );
  });

  it("show the read-only view instead of the new employee type form", async () => {
    fake.state.status = MANAGED;
    h.loaderData = await newType.loader(args());
    const view = newType.default() as ReturnType<typeof createElement>;
    expect((view.type as { displayName?: string }).displayName).toBe(
      "AuthzManagedPermissions"
    );
  });

  it("show a person's permissions read-only while managed", () => {
    h.loaderData = {
      permissions: {
        sales: { view: true, create: false, update: false, delete: false }
      },
      employee: {
        id: "usr_1",
        name: "Synthetic Person",
        employeeTypeId: "et_1"
      },
      employeeTypes: [],
      employeeTypePermissions: {},
      authz: { managed: true, accessUrl: "https://hq.example.com/admin/access" }
    };
    const view = employee.default() as ReturnType<typeof createElement>;
    expect((view.type as { displayName?: string }).displayName).toBe(
      "AuthzManagedPermissions"
    );
    expect(view.props).toMatchObject({
      title: "Synthetic Person",
      companyPermissions: h.loaderData.permissions
    });
    h.loaderData = {
      ...h.loaderData,
      authz: { managed: false, accessUrl: null }
    };
    const editor = employee.default() as ReturnType<typeof createElement>;
    expect((editor.type as { displayName?: string }).displayName).toBe(
      "EmployeePermissionsForm"
    );
  });
});
