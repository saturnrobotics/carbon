import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.175.0/testing/asserts.ts";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import {
  ensureSystemEmployeeType,
  getPermissionsManagement,
  managedInHqMessage,
  permissionsManagementFrom,
} from "./saturn-authz.ts";

/** A Kysely database that answers every query with `rows` and records it. */
function fakeDatabase(rows: unknown[]) {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return Promise.resolve({ rows: rows as R[] });
    },
    streamQuery() {
      throw new Error("not used");
    },
  };
  const nothing = () => Promise.resolve();
  const driver: Driver = {
    init: nothing,
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: nothing,
    commitTransaction: nothing,
    rollbackTransaction: nothing,
    releaseConnection: nothing,
    destroy: nothing,
  };
  const db = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const ACCESS_URL = "https://hq.example.com/admin/access";

Deno.test("the lock is on exactly when the projection is enabled", () => {
  assertEquals(permissionsManagementFrom(undefined), {
    managed: false,
    accessUrl: null,
  });
  assertEquals(
    permissionsManagementFrom({ enabled: false, access_url: ACCESS_URL }),
    { managed: false, accessUrl: null },
  );
  assertEquals(
    permissionsManagementFrom({ enabled: true, access_url: ACCESS_URL }),
    { managed: true, accessUrl: ACCESS_URL },
  );
});

Deno.test("reads carbon_private's status function", async () => {
  const { db, queries } = fakeDatabase([
    { enabled: true, access_url: ACCESS_URL },
  ]);
  assertEquals(await getPermissionsManagement(db), {
    managed: true,
    accessUrl: ACCESS_URL,
  });
  assertEquals(
    queries.map((q) => q.sql.trim()),
    ["SELECT enabled, access_url FROM carbon_private.authz_projection_status()"],
  );
});

Deno.test("ensures a system employee type through the narrow writer", async () => {
  const { db, queries } = fakeDatabase([{ id: "et_admin" }]);
  assertEquals(await ensureSystemEmployeeType(db, "cmp_1", "Admin"), "et_admin");
  assertEquals(queries.length, 1);
  assertEquals(
    queries[0].sql.trim(),
    "SELECT carbon_private.authz_ensure_system_employee_type($1, $2) AS id",
  );
  assertEquals(queries[0].parameters, ["cmp_1", "Admin"]);
});

Deno.test("a missing employee type fails the flow", async () => {
  const { db } = fakeDatabase([{ id: null }]);
  await assertRejects(
    () => ensureSystemEmployeeType(db, "cmp_1", "Console Operator"),
    Error,
    "Console Operator",
  );
});

Deno.test("the outcome names HQ's access page", () => {
  assertEquals(
    managedInHqMessage(ACCESS_URL),
    `Carbon permissions are managed in HQ. Change access at ${ACCESS_URL}`,
  );
});
