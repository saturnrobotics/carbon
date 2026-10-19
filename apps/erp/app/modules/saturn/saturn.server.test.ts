import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeStatusDatabase, MANAGED } from "./saturn.test-db";

const harness = vi.hoisted(() => ({
  database: null as unknown,
  logged: [] as unknown[]
}));

vi.mock("@carbon/auth/session.server", () => ({
  // The real flash returns ResponseInit with the session cookie.
  flash: vi.fn(async (_request: Request, result: { message: string }) => ({
    headers: { "X-Flash": result.message }
  }))
}));
vi.mock("@carbon/logger", () => ({
  getLogger: () => ({
    error: (...args: unknown[]) => harness.logged.push(args)
  })
}));
vi.mock("~/services/database.server", () => ({
  getDatabaseClient: () => harness.database
}));

import { flash } from "@carbon/auth/session.server";
import {
  getAuthzManagement,
  refuseLockedAuthzOperation,
  refuseWhileAuthzManaged
} from "./saturn.server";

let fake: ReturnType<typeof fakeStatusDatabase>;

beforeEach(() => {
  fake = fakeStatusDatabase();
  harness.database = fake.db;
  harness.logged = [];
  vi.mocked(flash).mockClear();
});

describe("getAuthzManagement", () => {
  it("reads carbon_private's status function", async () => {
    await expect(getAuthzManagement()).resolves.toEqual({
      managed: false,
      accessUrl: null
    });
    expect(fake.state.queries).toEqual([
      "SELECT enabled, access_url FROM carbon_private.authz_projection_status()"
    ]);

    fake.state.status = MANAGED;
    await expect(getAuthzManagement()).resolves.toEqual({
      managed: true,
      accessUrl: "https://hq.example.com/admin/access"
    });
  });

  it("treats a failed read as not managed, for display only", async () => {
    fake.state.status = new Error("connection refused");
    await expect(getAuthzManagement()).resolves.toEqual({
      managed: false,
      accessUrl: null
    });
    expect(harness.logged).toHaveLength(1);
  });
});

describe("refuseWhileAuthzManaged", () => {
  const request = new Request("https://erp.example.com/x/users/employees/u1", {
    method: "POST"
  });

  it("lets the action continue while Carbon manages its own permissions", async () => {
    await expect(
      refuseWhileAuthzManaged(request, "/x/users/employees")
    ).resolves.toBeUndefined();
    expect(flash).not.toHaveBeenCalled();
  });

  it("redirects with a pointer to HQ while HQ manages them", async () => {
    fake.state.status = MANAGED;
    const thrown = await refuseWhileAuthzManaged(
      request,
      "/x/users/employees"
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/x/users/employees");
    expect(response.headers.get("X-Flash")).toBe(
      "Carbon permissions are managed in HQ. Change access at https://hq.example.com/admin/access"
    );
  });
});

describe("refuseLockedAuthzOperation", () => {
  it.each([
    "users_insertEmployeeType",
    "users_upsertEmployeeType",
    "users_upsertEmployeeTypePermissions",
    "users_deleteEmployeeType"
  ])("refuses %s while HQ manages permissions", async (name) => {
    fake.state.status = MANAGED;
    const thrown = await refuseLockedAuthzOperation(name).catch(
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
    expect((thrown as Error).message).toContain(
      "https://hq.example.com/admin/access"
    );
  });

  it("allows them before cutover", async () => {
    await expect(
      refuseLockedAuthzOperation("users_upsertEmployeeTypePermissions")
    ).resolves.toBeUndefined();
  });

  it("never consults the database for other operations", async () => {
    fake.state.status = MANAGED;
    await expect(
      refuseLockedAuthzOperation("users_getEmployeeTypes")
    ).resolves.toBeUndefined();
    await expect(
      refuseLockedAuthzOperation("sales_upsertQuote")
    ).resolves.toBeUndefined();
    expect(fake.state.queries).toEqual([]);
  });
});
