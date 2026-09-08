import type { Pool } from "pg";
import type { Principal } from "./contracts";
import { withKnowledgeTransaction } from "./database.server";

export type BudgetReservation = {
  endpoint: string;
  requestId: string;
  payloadHash: string;
  maxTokens: number;
  maxMicroUsd: number;
};
/** Separate operational functions cannot mutate any business/source table. */
export function durableBudget(
  pool: Pool,
  principal: Principal,
  sourceId?: string
) {
  if (
    principal.kind === "machine" &&
    (!sourceId ||
      !principal.sourceIds.includes(sourceId) ||
      !principal.capabilities.includes("source.index.read"))
  )
    throw Error("Registered machine source required for indexing billing");
  const databasePrincipal = { ...principal, sourceId };
  return {
    async reserve(reservation: BudgetReservation) {
      if (
        !Number.isSafeInteger(reservation.maxTokens) ||
        !Number.isSafeInteger(reservation.maxMicroUsd) ||
        reservation.maxTokens < 1 ||
        reservation.maxMicroUsd < 1
      )
        throw Error("Invalid billable ceiling");
      const result = await withKnowledgeTransaction(
        pool,
        databasePrincipal,
        "write",
        async (client) => {
          const rows = await client.query<{
            result: { acquired: boolean; settled: boolean };
          }>(
            "SELECT knowledge_metering.reserve($1,$2,$3,$4::bigint,$5::bigint) AS result",
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
      if (
        !Number.isSafeInteger(actualTokens) ||
        !Number.isSafeInteger(actualMicroUsd) ||
        actualTokens < 0 ||
        actualMicroUsd < 0
      )
        throw Error("Invalid provider usage");
      await withKnowledgeTransaction(
        pool,
        databasePrincipal,
        "write",
        async (client) => {
          await client.query(
            "SELECT knowledge_metering.settle($1,$2,$3::bigint,$4::bigint)",
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
  endpoint: "knowledge.query" | "knowledge.entity"
) {
  if (
    principal.kind !== "human" ||
    !principal.capabilities.includes("knowledge.read")
  )
    return false;
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const result = await client.query<{ allowed: boolean }>(
      "SELECT knowledge_metering.admit_request($1) AS allowed",
      [endpoint]
    );
    return result.rows[0]?.allowed === true;
  });
}
