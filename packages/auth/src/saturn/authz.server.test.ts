// Deactivation while HQ manages Carbon's permissions (HQ plan 0006B B7): the
// real deactivate* functions run against a recording Supabase client. While the
// projection is off they strip the company from userPermission exactly as
// upstream does; while it is on they write membership only and say so.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  status: { enabled: false, access_url: null } as
    | { enabled: boolean; access_url: string | null }
    | Error,
  statusQueries: [] as string[],
  roleChanges: [] as Record<string, unknown>[],
  logged: [] as unknown[]
}));

vi.mock("@carbon/database/client", () => ({
  getPostgresConnectionPool: () => ({
    query: async (text: string) => {
      h.statusQueries.push(text);
      if (h.status instanceof Error) throw h.status;
      return { rows: [h.status] };
    }
  })
}));
vi.mock("@carbon/kv", () => ({
  redis: { del: vi.fn(), get: vi.fn(), set: vi.fn() }
}));
vi.mock("@carbon/logger", () => ({
  getLogger: () => ({
    error: (...args: unknown[]) => h.logged.push(args),
    info: vi.fn(),
    warn: vi.fn()
  })
}));
vi.mock("../lib/supabase/client.server", () => ({
  getCarbonServiceRole: () => {
    throw new Error("deactivation uses the caller's client");
  }
}));
// users.server's siblings read the environment; deactivation uses neither.
vi.mock("../services/users", () => ({
  getClaims: vi.fn(),
  getPermissionCacheKey: (userId: string) => `permissions:${userId}`,
  makePermissionsFromClaims: vi.fn()
}));
vi.mock("../services/auth-events.server", () => ({
  logRoleChange: (fields: Record<string, unknown>) => h.roleChanges.push(fields)
}));

import {
  deactivateCustomer,
  deactivateEmployee,
  deactivateSupplier
} from "../services/users.server";
import {
  getPermissionsManagement,
  managedInHqMessage,
  skippedPermissionWrite,
  withPermissionsNotice
} from "./authz.server";

const COMPANY = "cmp_1";
const OTHER = "cmp_2";
const USER = "usr_1";
const ACCESS_URL = "https://hq.example.com/admin/access";
const MANAGED = { enabled: true, access_url: ACCESS_URL };
const STORED = { sales_view: [COMPANY, OTHER], parts_view: [COMPANY] };

type Op = {
  table: string;
  action: "select" | "insert" | "update" | "delete" | "upsert";
  values?: unknown;
  filters: string[];
};

/** A Supabase client that records every request and answers it. */
function recordingClient() {
  const ops: Op[] = [];
  const answer = (op: Op) => {
    if (op.table === "userPermission" && op.action === "select") {
      return { data: { id: USER, permissions: STORED }, error: null };
    }
    if (op.table === "group" && op.action === "select") {
      return { data: [{ id: "grp_1" }], error: null };
    }
    return { data: null, error: null };
  };
  const client = {
    from(table: string) {
      const builder = (action: Op["action"], values?: unknown) => {
        const op: Op = { table, action, values, filters: [] };
        ops.push(op);
        const chain = {
          eq: (column: string, value: unknown) => {
            op.filters.push(`${column}=${value}`);
            return chain;
          },
          in: (column: string, value: unknown[]) => {
            op.filters.push(`${column} in ${value.join(",")}`);
            return chain;
          },
          maybeSingle: () => chain,
          then: (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve(answer(op)).then(resolve, reject)
        };
        return chain;
      };
      return {
        select: () => builder("select"),
        update: (values: unknown) => builder("update", values),
        delete: () => builder("delete"),
        insert: (values: unknown) => builder("insert", values),
        upsert: (values: unknown) => builder("upsert", values)
      };
    }
  };
  return { client: client as never, ops };
}

const writes = (ops: Op[]) =>
  ops
    .filter((op) => op.action !== "select")
    .map((op) => `${op.action} ${op.table}`);

beforeEach(() => {
  h.status = { enabled: false, access_url: null };
  h.statusQueries = [];
  h.roleChanges = [];
  h.logged = [];
});

describe("getPermissionsManagement", () => {
  it("reads carbon_private's status function", async () => {
    await expect(getPermissionsManagement()).resolves.toEqual({
      managed: false,
      accessUrl: null
    });
    expect(h.statusQueries).toEqual([
      "SELECT enabled, access_url FROM carbon_private.authz_projection_status()"
    ]);
    h.status = MANAGED;
    await expect(getPermissionsManagement()).resolves.toEqual({
      managed: true,
      accessUrl: ACCESS_URL
    });
  });

  it("falls back to upstream's behaviour when the read fails", async () => {
    h.status = new Error("connection refused");
    await expect(getPermissionsManagement()).resolves.toEqual({
      managed: false,
      accessUrl: null
    });
    expect(h.logged).toHaveLength(1);
  });

  it("only skips a write and adds a notice while managed", async () => {
    const off = { managed: false, accessUrl: null } as const;
    const on = { managed: true, accessUrl: ACCESS_URL } as const;
    expect(skippedPermissionWrite(off)).toBeUndefined();
    await expect(skippedPermissionWrite(on)).resolves.toEqual({
      data: null,
      error: null
    });
    expect(withPermissionsNotice("Done", off)).toBe("Done");
    expect(withPermissionsNotice("Done", on)).toBe(
      `Done. ${managedInHqMessage(ACCESS_URL)}`
    );
  });
});

const FLOWS = [
  ["employee", deactivateEmployee, "employee"],
  ["customer", deactivateCustomer, "customerAccount"],
  ["supplier", deactivateSupplier, "supplierAccount"]
] as const;

describe.each(FLOWS)("deactivate %s", (kind, deactivate, accountTable) => {
  it("strips the company from userPermission while Carbon manages permissions", async () => {
    const { client, ops } = recordingClient();
    const result = await deactivate(client, USER, COMPANY, "usr_admin");

    expect(result).toEqual({
      success: true,
      message: `Sucessfully deactivated ${kind}`
    });
    const update = ops.find(
      (op) => op.table === "userPermission" && op.action === "update"
    );
    expect(update?.values).toEqual({
      permissions: { sales_view: [OTHER], parts_view: [] }
    });
    expect(update?.filters).toEqual([`id=${USER}`]);
    expect(h.roleChanges[0]).toMatchObject({
      before: STORED,
      after: { sales_view: [OTHER], parts_view: [] }
    });
  });

  it("writes membership only while HQ manages permissions", async () => {
    h.status = MANAGED;
    const { client, ops } = recordingClient();
    const result = await deactivate(client, USER, COMPANY, "usr_admin");

    expect(result).toEqual({
      success: true,
      message: `Sucessfully deactivated ${kind}. ${managedInHqMessage(ACCESS_URL)}`
    });
    expect(
      ops.filter(
        (op) => op.table === "userPermission" && op.action !== "select"
      )
    ).toEqual([]);
    // Membership still goes: the company link, the account row, group membership.
    expect(writes(ops)).toEqual(
      expect.arrayContaining([
        "delete userToCompany",
        `${kind === "employee" ? "update" : "delete"} ${accountTable}`,
        "delete membership"
      ])
    );
    expect(h.roleChanges[0]).toMatchObject({
      afterRole: null,
      before: STORED,
      after: STORED
    });
  });
});
