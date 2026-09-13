import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "./contracts";

const transaction = vi.hoisted(() => ({
  ledger: vi.fn<(query: string, values: unknown[]) => Promise<unknown>>()
}));
vi.mock("./database.server", () => ({
  withPortalTransaction: async (
    _pool: unknown,
    principal: { companyId: string; callerId: string },
    _access: string,
    operation: (client: {
      query: (query: string, values: unknown[]) => Promise<unknown>;
    }) => Promise<unknown>
  ) => {
    if (!principal.companyId || !principal.callerId)
      throw new Error("Verified database principal required");
    return operation({ query: transaction.ledger });
  }
}));

import {
  admitReadRequest,
  assertBillableCeiling,
  assertProviderUsage,
  durableBudget,
  requireBillableSource
} from "./budgets.server";

const pool = {} as Pool;
const human: Principal = {
  kind: "human",
  actorId: "alice",
  companyId: "company-a",
  callerId: "query",
  sourceIdentity: { issuer: "https://cloud.google.com/iap", subject: "alice" },
  policyVersion: "1",
  capabilities: ["portal.read"]
};
const machine: Principal = {
  kind: "machine",
  callerId: "indexer",
  companyId: "company-a",
  sourceIds: ["source-a"],
  policyVersion: "1",
  capabilities: ["source.index.read"]
};
const reservation = {
  endpoint: "answer",
  requestId: "request-1",
  payloadHash: "a".repeat(64),
  maxTokens: 400,
  maxMicroUsd: 400
};

beforeEach(() => {
  transaction.ledger.mockReset();
});

describe("billable ceilings", () => {
  it("accepts only positive safe-integer token and spend ceilings", () => {
    expect(() => assertBillableCeiling(reservation)).not.toThrow();
    for (const invalid of [
      { maxTokens: 0 },
      { maxMicroUsd: 0 },
      { maxTokens: -1 },
      { maxTokens: 1.5 },
      { maxMicroUsd: Number.NaN },
      { maxMicroUsd: Number.POSITIVE_INFINITY },
      { maxTokens: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      expect(() =>
        assertBillableCeiling({ ...reservation, ...invalid })
      ).toThrow("Invalid billable ceiling");
    }
  });

  it("accepts only non-negative safe-integer settled usage", () => {
    expect(() => assertProviderUsage(0, 0)).not.toThrow();
    expect(() => assertProviderUsage(399, 400)).not.toThrow();
    for (const [tokens, microUsd] of [
      [-1, 0],
      [0, -1],
      [0.5, 0],
      [Number.NaN, 0],
      [0, Number.MAX_SAFE_INTEGER + 1]
    ]) {
      expect(() => assertProviderUsage(tokens!, microUsd!)).toThrow(
        "Invalid provider usage"
      );
    }
  });
});

describe("billable principals", () => {
  it("binds a machine principal to a registered source it indexes", () => {
    expect(requireBillableSource(machine, "source-a")).toEqual({
      ...machine,
      sourceId: "source-a"
    });
    expect(() => requireBillableSource(machine)).toThrow(
      "Registered machine source required"
    );
    expect(() => requireBillableSource(machine, "source-b")).toThrow(
      "Registered machine source required"
    );
    expect(() =>
      requireBillableSource(
        { ...machine, capabilities: ["source.changes.read"] },
        "source-a"
      )
    ).toThrow("Registered machine source required");
    expect(requireBillableSource(human)).toEqual({
      ...human,
      sourceId: undefined
    });
  });
});

describe("durable reservation and settlement", () => {
  it("reserves through the ledger with the validated ceiling", async () => {
    transaction.ledger.mockResolvedValue({
      rows: [{ result: { acquired: true, settled: false } }]
    });
    await durableBudget(pool, human).reserve(reservation);
    expect(transaction.ledger).toHaveBeenCalledWith(
      expect.stringContaining("portal_metering.reserve"),
      ["answer", "request-1", "a".repeat(64), 400, 400]
    );
  });

  it("refuses an exhausted or duplicate reservation and never retries it", async () => {
    transaction.ledger.mockResolvedValue({
      rows: [{ result: { acquired: false, settled: false } }]
    });
    await expect(
      durableBudget(pool, human).reserve(reservation)
    ).rejects.toThrow(
      "Billable request already reserved; automatic retry denied"
    );
    transaction.ledger.mockResolvedValue({ rows: [] });
    await expect(
      durableBudget(pool, human).reserve(reservation)
    ).rejects.toThrow("automatic retry denied");
    transaction.ledger.mockRejectedValue(new Error("company budget exhausted"));
    await expect(
      durableBudget(pool, human).reserve(reservation)
    ).rejects.toThrow("company budget exhausted");
  });

  it("rejects an invalid ceiling before any ledger write", async () => {
    await expect(
      durableBudget(pool, human).reserve({ ...reservation, maxTokens: 0 })
    ).rejects.toThrow("Invalid billable ceiling");
    await expect(
      durableBudget(pool, human).settle("answer", "request-1", -1, 0)
    ).rejects.toThrow("Invalid provider usage");
    expect(transaction.ledger).not.toHaveBeenCalled();
  });

  it("settles actual usage through the ledger under the same principal", async () => {
    transaction.ledger.mockResolvedValue({ rows: [] });
    await durableBudget(pool, machine, "source-a").settle(
      "index",
      "request-2",
      120,
      90
    );
    expect(transaction.ledger).toHaveBeenCalledWith(
      expect.stringContaining("portal_metering.settle"),
      ["index", "request-2", 120, 90]
    );
  });
});

describe("read admission", () => {
  it("denies machines and humans without the read capability before touching the ledger", async () => {
    await expect(admitReadRequest(pool, machine, "portal.query")).resolves.toBe(
      false
    );
    await expect(
      admitReadRequest(pool, { ...human, capabilities: [] }, "portal.query")
    ).resolves.toBe(false);
    expect(transaction.ledger).not.toHaveBeenCalled();
  });

  it("admits only an explicit ledger allowance", async () => {
    transaction.ledger.mockResolvedValue({ rows: [{ allowed: true }] });
    await expect(admitReadRequest(pool, human, "portal.query")).resolves.toBe(
      true
    );
    transaction.ledger.mockResolvedValue({ rows: [{ allowed: false }] });
    await expect(admitReadRequest(pool, human, "portal.entity")).resolves.toBe(
      false
    );
    transaction.ledger.mockResolvedValue({ rows: [] });
    await expect(admitReadRequest(pool, human, "portal.query")).resolves.toBe(
      false
    );
  });
});
