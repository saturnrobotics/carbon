// Company restore while HQ manages Carbon's permissions (HQ plan 0006B B7).
//
// The in-place restore and the reseed import load under
// session_replication_role = 'replica', where the permission lock's triggers do
// not fire. They stay membership-only because they never wipe or load the locked
// tables: employeeType and employeeTypePermission are kept, and userPermission
// has no company scope, so it is never in the catalog. (Onboarding's restore from
// a backup seeds the identity layer through seed-company, which writes
// membership only while HQ manages permissions.) This pins that, so an upstream
// change to the kept sets fails here rather than slipping past the lock.
import { describe, expect, it } from "vitest";
import {
  type Catalog,
  type ColumnInfo,
  IN_PLACE_SKIPPED_TABLES,
  RESEED_SKIPPED_TABLES,
  selectWipeableTables,
  type TableInfo
} from "../inngest/functions/tasks/company-backup";

const LOCKED_COMPANY_TABLES = ["employeeType", "employeeTypePermission"];

function col(name: string): ColumnInfo {
  return {
    name,
    dataType: "text",
    udtName: "text",
    isNullable: false,
    isGenerated: false,
    hasDefault: false
  };
}

function table(
  name: string,
  scope: TableInfo["scope"],
  columns: string[]
): TableInfo {
  return {
    name,
    columns: columns.map(col),
    scope,
    scopeColumn: "companyId",
    pkColumns: ["id"],
    uniqueColumns: ["id"],
    hasId: true,
    foreignKeys: []
  };
}

// The shape getCompanyTableCatalog reads: employeeType carries companyId, and
// employeeTypePermission reaches it through employeeTypeId.
const catalog: Catalog = {
  schemaVersion: "test",
  tables: [
    table("item", { kind: "direct", column: "companyId" }, ["id", "companyId"]),
    table("employeeType", { kind: "direct", column: "companyId" }, [
      "id",
      "companyId"
    ]),
    table(
      "employeeTypePermission",
      {
        kind: "via",
        column: "employeeTypeId",
        refColumn: "id",
        parent: "employeeType"
      },
      ["id", "employeeTypeId"]
    )
  ]
};

describe("company restore and the permission lock", () => {
  it.each([
    { remap: false, includeGroup: false },
    { remap: false, includeGroup: true },
    { remap: true, includeGroup: true }
  ])("never wipes or reloads the locked tables (%o)", (opts) => {
    const names = selectWipeableTables(catalog, opts).map((t) => t.name);
    expect(names).toEqual(["item"]);
  });

  it("keeps them out of the in-place restore and the reseed import", () => {
    for (const name of LOCKED_COMPANY_TABLES) {
      expect(IN_PLACE_SKIPPED_TABLES.has(name)).toBe(true);
      expect(RESEED_SKIPPED_TABLES).toContain(name);
    }
  });
});
