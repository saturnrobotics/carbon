// Saturn fork, HQ plan 0006B (B7): Carbon's side of the central authz service.
//
// hq-authz decides Carbon's permissions. Every minute this applies its
// projection to userPermission through the database's own projection path
// (carbon_private.authz_projection_sync, migration *_saturn-authz-projection),
// then deletes the cached claims (Redis permissions:<uid>) of every user whose
// row changed, as ERP's updatePermissions does after its own writes. Nothing
// crosses a wire: the database reads authz itself, so no payload can be forged.
//
// Users to invalidate come from a queue the database fills on every projection
// write, whoever made it, and an entry is acknowledged only after Redis
// confirmed the delete; while Redis is down the entries wait for the next run.
// While the projection is off the sync does nothing and the queue stays empty.
import { getPermissionCacheKey } from "@carbon/auth";
import { sql } from "kysely";
import type { JobDatabase } from "../db";

/** The one Redis call this needs; @carbon/kv resolves null when Redis is down. */
export type PermissionCache = {
  del(...keys: string[]): Promise<number | null>;
};

export type AuthzProjectionRun = {
  /** "off" until an operator enables the projection after HQ's C3 gate. */
  state: "off" | "applied";
  /** Rows the sync changed: 0 when Carbon already matched authz. */
  changed: number;
  /** authz.epoch() the sync covered, for the lag alert (plan 0006B Q7). */
  epoch: string | null;
  invalidated: number;
  /** Queued invalidations left for the next run. */
  pending: number;
};

const INVALIDATION_BATCH = 500;

export async function runAuthzProjection(
  db: JobDatabase,
  cache: PermissionCache
): Promise<AuthzProjectionRun> {
  const { rows } = await sql<{
    applied: boolean;
    changed: number;
    epoch: string | null;
  }>`SELECT applied, changed, epoch FROM carbon_private.authz_projection_sync()`.execute(
    db
  );
  const sync = rows[0];
  const invalidation = await invalidateProjectedClaims(db, cache);
  return {
    state: sync?.applied ? "applied" : "off",
    changed: sync?.changed ?? 0,
    epoch: sync?.epoch ?? null,
    ...invalidation
  };
}

export async function invalidateProjectedClaims(
  db: JobDatabase,
  cache: PermissionCache
): Promise<Pick<AuthzProjectionRun, "invalidated" | "pending">> {
  const { rows } = await sql<{
    user_id: string;
    seq: string;
  }>`SELECT user_id, seq FROM carbon_private.authz_pending_invalidations(${INVALIDATION_BATCH})`.execute(
    db
  );
  if (rows.length === 0) return { invalidated: 0, pending: 0 };

  const deleted = await cache.del(
    ...rows.map((row) => getPermissionCacheKey(row.user_id))
  );
  if (typeof deleted !== "number") {
    return { invalidated: 0, pending: rows.length };
  }

  await sql`SELECT carbon_private.authz_ack_invalidations(${rows.map(
    (row) => row.seq
  )}::bigint[])`.execute(db);
  return { invalidated: rows.length, pending: 0 };
}
