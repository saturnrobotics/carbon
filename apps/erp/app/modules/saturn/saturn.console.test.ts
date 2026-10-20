// Console mode while HQ manages Carbon's permissions (HQ plan 0006B B7). The real
// Settings → People action and upstream's real updateConsoleSetting run against a
// recording Supabase client and a fake database: before cutover upstream inserts
// the Console Operator type and its template permissions; while HQ manages
// permissions the type is created first, without a template, through
// carbon_private's writer, so upstream finds it and writes neither.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeStatusDatabase, MANAGED } from "./saturn.test-db";

const h = vi.hoisted(() => ({
  database: null as unknown,
  client: null as unknown
}));

vi.mock("@carbon/auth/auth.server", () => ({
  requirePermissions: vi.fn(async () => ({
    client: h.client,
    companyId: "cmp_1",
    userId: "usr_admin"
  }))
}));
vi.mock("@carbon/auth/session.server", () => ({ flash: vi.fn() }));
// Only the action runs; the screen's UI is never rendered.
vi.mock("@carbon/react", () => ({}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => parts.join("")
}));
vi.mock("@lingui/react/macro", () => ({ Trans: () => null }));
vi.mock("~/services/database.server", () => ({
  getDatabaseClient: () => h.database
}));
vi.mock("~/modules/settings", async () => {
  const service = await vi.importActual<
    typeof import("~/modules/settings/settings.service")
  >("~/modules/settings/settings.service");
  return {
    getCompanySettings: vi.fn(),
    updateConsoleSetting: service.updateConsoleSetting,
    updateTimeCardSetting: vi.fn()
  };
});

import { action } from "~/routes/x+/settings+/people";
import { authzManagedMessage } from "./saturn.models";

type Op = { table: string; action: string; values?: unknown };

/** A Supabase client that records every request. The company has a Console
 *  Operator type only once `typeExists()` says so. */
function recordingClient(typeExists: () => boolean) {
  const ops: Op[] = [];
  const answer = (op: Op) => {
    if (op.table === "employeeType" && op.action === "select") {
      return { data: typeExists() ? { id: "et_system" } : null, error: null };
    }
    if (op.table === "employeeType" && op.action === "insert") {
      return { data: { id: "et_new" }, error: null };
    }
    return { data: null, error: null };
  };
  const client = {
    from(table: string) {
      const builder = (action: string, values?: unknown) => {
        const op = { table, action, values };
        ops.push(op);
        const chain = {
          eq: () => chain,
          select: () => chain,
          single: () => chain,
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
        insert: (values: unknown) => builder("insert", values),
        update: (values: unknown) => builder("update", values)
      };
    }
  };
  return { client, ops };
}

const toggle = (enabled: boolean) => {
  const body = new FormData();
  body.set("intent", "console");
  body.set("enabled", String(enabled));
  return action({
    request: new Request("https://erp.example.com/x/settings/people", {
      method: "POST",
      body
    }),
    params: {},
    context: {}
  } as unknown as Parameters<typeof action>[0]);
};

const writes = (ops: Op[]) =>
  ops.filter((op) => op.action !== "select").map((op) => op.table);

let fake: ReturnType<typeof fakeStatusDatabase>;
let ops: Op[];
beforeEach(() => {
  fake = fakeStatusDatabase();
  h.database = fake.db;
  const recording = recordingClient(() => fake.state.parameters.length > 0);
  h.client = recording.client;
  ops = recording.ops;
});

describe("enabling console mode", () => {
  it("inserts the type and its template as upstream does before cutover", async () => {
    await expect(toggle(true)).resolves.toEqual({
      success: true,
      message: "Console mode settings updated"
    });
    expect(writes(ops)).toEqual([
      "companySettings",
      "employeeType",
      "employeeTypePermission"
    ]);
    expect(fake.state.parameters).toEqual([]);
  });

  it("writes membership only while HQ manages permissions", async () => {
    fake.state.status = MANAGED;
    await expect(toggle(true)).resolves.toEqual({
      success: true,
      message: `Console mode settings updated. ${authzManagedMessage(
        MANAGED.access_url!
      )}`
    });
    expect(fake.state.parameters).toEqual([["cmp_1", "Console Operator"]]);
    expect(writes(ops)).toEqual(["companySettings"]);
  });
});

describe("disabling console mode", () => {
  it("reads and writes nothing of the lock's", async () => {
    fake.state.status = MANAGED;
    await expect(toggle(false)).resolves.toEqual({
      success: true,
      message: "Console mode settings updated"
    });
    expect(fake.state.queries).toEqual([]);
    expect(writes(ops)).toEqual(["companySettings"]);
  });
});
