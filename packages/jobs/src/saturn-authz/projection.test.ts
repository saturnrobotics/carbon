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
import { describe, expect, it, vi } from "vitest";
import type { JobDatabase } from "../db";

// The @carbon/auth barrel needs the app environment; this is its key function.
vi.mock("@carbon/auth", () => ({
  getPermissionCacheKey: (userId: string) => `permissions:${userId}`
}));

import {
  invalidateProjectedClaims,
  type PermissionCache,
  runAuthzProjection
} from "./projection";

type Executed = { sql: string; parameters: readonly unknown[] };

/** A Kysely database whose queries are answered by `answer` and recorded. */
function fakeDatabase(answer: (sql: string) => unknown[]) {
  const executed: Executed[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      executed.push({ sql: query.sql, parameters: query.parameters });
      return { rows: answer(query.sql) as R[] };
    },
    streamQuery() {
      throw new Error("not used");
    }
  };
  // Connection and transaction lifecycle are no-ops for a canned answer.
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
  }) as unknown as JobDatabase;
  return { db, executed };
}

function cache(result: number | null): PermissionCache & {
  del: ReturnType<typeof vi.fn>;
} {
  return { del: vi.fn(async () => result) };
}

const PENDING = [
  { user_id: "user-a", seq: "7" },
  { user_id: "user-b", seq: "9" }
];

describe("runAuthzProjection", () => {
  it("does nothing beyond asking while the projection is off", async () => {
    const { db, executed } = fakeDatabase((sql) =>
      sql.includes("authz_projection_sync")
        ? [{ applied: false, changed: 0, epoch: null }]
        : []
    );
    const redis = cache(0);

    await expect(runAuthzProjection(db, redis)).resolves.toEqual({
      state: "off",
      changed: 0,
      epoch: null,
      invalidated: 0,
      pending: 0
    });
    expect(executed.map((q) => q.sql)).toEqual([
      "SELECT applied, changed, epoch FROM carbon_private.authz_projection_sync()",
      "SELECT user_id, seq FROM carbon_private.authz_pending_invalidations($1)"
    ]);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("deletes each changed user's cached claims, then acknowledges them", async () => {
    const { db, executed } = fakeDatabase((sql) => {
      if (sql.includes("authz_projection_sync")) {
        return [{ applied: true, changed: 2, epoch: "41" }];
      }
      if (sql.includes("authz_pending_invalidations")) return PENDING;
      return [{ authz_ack_invalidations: 2 }];
    });
    const redis = cache(2);

    await expect(runAuthzProjection(db, redis)).resolves.toEqual({
      state: "applied",
      changed: 2,
      epoch: "41",
      invalidated: 2,
      pending: 0
    });
    // The key ERP's updatePermissions deletes (getPermissionCacheKey).
    expect(redis.del).toHaveBeenCalledWith(
      "permissions:user-a",
      "permissions:user-b"
    );
    const ack = executed.at(-1);
    expect(ack?.sql).toBe(
      "SELECT carbon_private.authz_ack_invalidations($1::bigint[])"
    );
    expect(ack?.parameters).toEqual([["7", "9"]]);
  });
});

describe("invalidateProjectedClaims", () => {
  it("keeps the queue when Redis is unavailable", async () => {
    const { db, executed } = fakeDatabase((sql) =>
      sql.includes("authz_pending_invalidations") ? PENDING : []
    );

    await expect(invalidateProjectedClaims(db, cache(null))).resolves.toEqual({
      invalidated: 0,
      pending: 2
    });
    expect(executed.some((q) => q.sql.includes("ack"))).toBe(false);
  });

  it("asks for a bounded batch", async () => {
    const { db, executed } = fakeDatabase(() => []);
    await invalidateProjectedClaims(db, cache(0));
    expect(executed[0]?.parameters).toEqual([500]);
  });
});
