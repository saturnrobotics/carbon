import type { Pool } from "pg";
import type { Principal } from "./contracts";
import { withPortalTransaction } from "./database.server";

export type BudgetReservation = {
  endpoint: string;
  requestId: string;
  payloadHash: string;
  maxTokens: number;
  maxMicroUsd: number;
};

/** Pure guards below are the TypeScript half of the budget contract; the ledger arithmetic lives in `portal_metering`. */

/** A ceiling is a positive safe integer pair; anything else is an invalid reservation, never a zero-cost one. */
export function assertBillableCeiling(reservation: BudgetReservation): void {
  if (
    !Number.isSafeInteger(reservation.maxTokens) ||
    !Number.isSafeInteger(reservation.maxMicroUsd) ||
    reservation.maxTokens < 1 ||
    reservation.maxMicroUsd < 1
  )
    throw Error("Invalid billable ceiling");
}

/** Settled usage is a non-negative safe integer pair; the ledger refuses usage above the reserved ceiling. */
export function assertProviderUsage(
  actualTokens: number,
  actualMicroUsd: number
): void {
  if (
    !Number.isSafeInteger(actualTokens) ||
    !Number.isSafeInteger(actualMicroUsd) ||
    actualTokens < 0 ||
    actualMicroUsd < 0
  )
    throw Error("Invalid provider usage");
}

/** A machine principal may only be billed against a registered source it indexes. */
export function requireBillableSource(
  principal: Principal,
  sourceId?: string
): Principal & { sourceId?: string } {
  if (
    principal.kind === "machine" &&
    (!sourceId ||
      !principal.sourceIds.includes(sourceId) ||
      !principal.capabilities.includes("source.index.read"))
  )
    throw Error("Registered machine source required for indexing billing");
  return { ...principal, sourceId };
}

/** Separate operational functions cannot mutate any business/source table. */
export function durableBudget(
  pool: Pool,
  principal: Principal,
  sourceId?: string
) {
  const databasePrincipal = requireBillableSource(principal, sourceId);
  return {
    async reserve(reservation: BudgetReservation) {
      assertBillableCeiling(reservation);
      const result = await withPortalTransaction(
        pool,
        databasePrincipal,
        "write",
        async (client) => {
          const rows = await client.query<{
            result: { acquired: boolean; settled: boolean };
          }>(
            "SELECT portal_metering.reserve($1,$2,$3,$4::bigint,$5::bigint) AS result",
            [
              reservation.endpoint,
              reservation.requestId,
              reservation.payloadHash,
              reservation.maxTokens,
              reservation.maxMicroUsd
            ]
          );
          return rows.rows[0]?.result;
        }
      );
      if (!result?.acquired)
        throw Error(
          "Billable request already reserved; automatic retry denied"
        );
    },
    async settle(
      endpoint: string,
      requestId: string,
      actualTokens: number,
      actualMicroUsd: number
    ) {
      assertProviderUsage(actualTokens, actualMicroUsd);
      await withPortalTransaction(
        pool,
        databasePrincipal,
        "write",
        async (client) => {
          await client.query(
            "SELECT portal_metering.settle($1,$2,$3::bigint,$4::bigint)",
            [endpoint, requestId, actualTokens, actualMicroUsd]
          );
        }
      );
    }
  };
}

/** Admission precedes cache/source work and remains enforced during cache loss. */
export async function admitReadRequest(
  pool: Pool,
  principal: Principal,
  endpoint: "portal.query" | "portal.entity"
) {
  if (
    principal.kind !== "human" ||
    !principal.capabilities.includes("portal.read")
  )
    return false;
  return withPortalTransaction(pool, principal, "write", async (client) => {
    const result = await client.query<{ allowed: boolean }>(
      "SELECT portal_metering.admit_request($1) AS allowed",
      [endpoint]
    );
    return result.rows[0]?.allowed === true;
  });
}
