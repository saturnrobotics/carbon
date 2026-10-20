// SSO provisioning while HQ manages Carbon's permissions (HQ plan 0006B B7): the
// real migrateUserToSso runs its transaction against a recording database. While
// the projection is off it merges the invite's permissions into userPermission
// as upstream does; while it is on it writes membership only and says so.
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult
} from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  status: { enabled: false, access_url: null as string | null },
  info: [] as unknown[][]
}));

vi.mock("@carbon/database/client", () => ({
  getPostgresConnectionPool: () => ({
    query: async () => ({ rows: [h.status] })
  })
}));
vi.mock("@carbon/auth", () => ({
  getPermissionCacheKey: (id: string) => `permissions:${id}`
}));
vi.mock("@carbon/kv", () => ({ redis: { del: vi.fn() } }));
vi.mock("@carbon/logger", () => ({
  getLogger: () => ({
    info: (...args: unknown[]) => h.info.push(args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));
vi.mock("@carbon/utils", () => ({
  datetime: { timestamp: () => "2026-01-01T00:00:00.000Z" }
}));

import { managedInHqMessage } from "@carbon/auth/saturn/authz.server";
import { migrateUserToSso } from "../sso/provisioning.server";

const USER = "usr_new";
const COMPANY = "cmp_1";
const ACCESS_URL = "https://hq.example.com/admin/access";

/** A Kysely database that records each statement and answers the reads. */
function recordingDatabase() {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      const text = query.sql;
      if (text.startsWith('select "id", "acceptedAt", "revokedAt"')) {
        return {
          rows: [{ id: "inv_1", acceptedAt: null, revokedAt: null }] as R[]
        };
      }
      if (text.startsWith('update "employee"')) {
        return { rows: [{ id: USER }] as R[] };
      }
      if (text.startsWith('select "permissions" from "userPermission"')) {
        return { rows: [{ permissions: { parts_view: [COMPANY] } }] as R[] };
      }
      return { rows: [] };
    },
    streamQuery() {
      throw new Error("not used");
    }
  };
  const nothing = async () => undefined;
  const driver: Driver = {
    init: nothing,
    acquireConnection: async () => connection,
    beginTransaction: nothing,
    commitTransaction: nothing,
    rollbackTransaction: nothing,
    releaseConnection: nothing,
    destroy: nothing
  };
  const db = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
  return { db, queries };
}

/** No other user row holds the email. */
const serviceRole = {
  from: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      maybeSingle: async () => ({ data: null, error: null })
    };
    return chain;
  }
};

const migrate = (db: Kysely<never>) =>
  migrateUserToSso(db as never, serviceRole as never, {
    newUserId: USER,
    email: "new.person@example.com",
    companyId: COMPANY,
    invite: {
      id: "inv_1",
      companyId: COMPANY,
      role: "employee",
      permissions: { sales_view: [COMPANY] }
    }
  });

const tables = (queries: CompiledQuery[]) =>
  queries.map((q) => q.sql.split(" ").slice(0, 3).join(" "));

beforeEach(() => {
  h.status = { enabled: false, access_url: null };
  h.info = [];
});

describe("migrateUserToSso", () => {
  it("merges the invite's permissions while Carbon manages permissions", async () => {
    const { db, queries } = recordingDatabase();
    await expect(migrate(db)).resolves.toEqual({
      data: { userId: USER, alreadyAccepted: false },
      error: null
    });
    const upsert = queries.find((q) =>
      q.sql.startsWith('insert into "userPermission"')
    );
    expect(upsert?.parameters).toContain(
      JSON.stringify({ parts_view: [COMPANY], sales_view: [COMPANY] })
    );
  });

  it("writes membership only while HQ manages permissions", async () => {
    h.status = { enabled: true, access_url: ACCESS_URL };
    const { db, queries } = recordingDatabase();
    await expect(migrate(db)).resolves.toEqual({
      data: { userId: USER, alreadyAccepted: false },
      error: null
    });
    expect(queries.filter((q) => q.sql.includes('"userPermission"'))).toEqual(
      []
    );
    expect(tables(queries)).toEqual(
      expect.arrayContaining([
        'update "employee" set',
        'insert into "userToCompany"',
        'update "invite" set'
      ])
    );
    expect(h.info.map(([message]) => message)).toContain(
      `The invite's permissions were not applied. ${managedInHqMessage(ACCESS_URL)}`
    );
  });
});
