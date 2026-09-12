import { procurementCommandPayloadHash } from "@carbon/knowledge/commands/procurement";
import { describe, expect, it, vi } from "vitest";
import {
  executeProcurementDraftCommand,
  ProcurementCommandAuthorizationError
} from "./procurement";

const lines = [
  {
    itemId: "PART-100",
    itemRevisionId: "item-revision-1",
    quantity: "2",
    purchaseUnitOfMeasureCode: "BOX",
    inventoryUnitOfMeasureCode: "EA",
    conversionFactor: "10",
    supplierUnitPrice: "1.25"
  }
];

const proposal = {
  id: "procurement-proposal-1",
  version: 1,
  action: "carbon.procurement.draft",
  idempotencyKey: "procurement-idempotency-1",
  supplierId: "supplier-1",
  receivingLocationId: "location-1",
  requestedArrivalDate: "2026-10-15",
  proposedOrderByDate: "2026-09-30",
  businessTimezone: "America/New_York",
  lines
};

const now = "2026-09-08T12:00:00.000Z";

const invoker = (capabilities: string[]) =>
  ({
    kind: "human",
    actorId: "user-1",
    companyId: "company-1",
    callerId: "iap:subject-1",
    sourceIdentity: {
      issuer: "https://issuer.example.test",
      subject: "subject-1"
    },
    capabilities,
    policyVersion: "v1"
  }) as const;

const envelope = () =>
  new Headers({
    authorization: "Bearer verified-service-token",
    "x-portal-user-evidence": "verified-iap"
  });

describe("executeProcurementDraftCommand", () => {
  it("forwards a deferred command with a deterministic hash and no credential", async () => {
    const requests: RequestInit[] = [];
    const result = await executeProcurementDraftCommand({
      command: proposal,
      principal: invoker(["carbon.procurement.draft"]),
      sourceUrl: "https://carbon.example.test/",
      forwardHeaders: envelope(),
      now,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(
          "https://carbon.example.test/api/v1/knowledge/createProcurementDraft"
        );
        requests.push(init!);
        return Response.json({
          scheduleId: "kps-1",
          status: "scheduled",
          executeAt: "2026-09-30T04:00:00.000Z",
          replayed: false
        });
      }
    });

    expect(result).toEqual({
      scheduleId: "kps-1",
      status: "scheduled",
      executeAt: "2026-09-30T04:00:00.000Z",
      replayed: false,
      idempotencyKey: "procurement-idempotency-1"
    });
    const body = JSON.parse(String(requests[0]?.body));
    // A future order date alone defers the command, on the proposal's own
    // business calendar (midnight in New York, not in UTC).
    expect(body.args.executeAt).toBe("2026-09-30T04:00:00.000Z");
    expect(body.args.payloadHash).toBe(
      procurementCommandPayloadHash({
        supplierId: proposal.supplierId,
        receivingLocationId: proposal.receivingLocationId,
        requestedArrivalDate: proposal.requestedArrivalDate,
        proposedOrderByDate: proposal.proposedOrderByDate,
        lines
      })
    );
    expect(body.args).not.toHaveProperty("actorId");
    expect(body.args).not.toHaveProperty("companyId");
    expect(body.args).not.toHaveProperty("authorization");
  });

  it("sends no executeAt when the order date is already here", async () => {
    let body: Record<string, unknown> = {};
    const result = await executeProcurementDraftCommand({
      command: { ...proposal, proposedOrderByDate: "2026-09-08" },
      principal: invoker(["carbon.procurement.draft"]),
      sourceUrl: "https://carbon.example.test",
      forwardHeaders: envelope(),
      now,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)).args;
        return Response.json({ purchaseOrderId: "po-1", replayed: false });
      }
    });
    expect(body).not.toHaveProperty("executeAt");
    expect(result.purchaseOrderId).toBe("po-1");
  });

  it("refuses a principal without the exact procurement capability", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeProcurementDraftCommand({
        command: proposal,
        principal: invoker(["knowledge.read"]),
        sourceUrl: "https://carbon.example.test",
        forwardHeaders: envelope(),
        now,
        fetchImpl
      })
    ).rejects.toThrow(ProcurementCommandAuthorizationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a machine principal outright", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeProcurementDraftCommand({
        command: proposal,
        principal: {
          kind: "machine",
          callerId: "indexer",
          companyId: "company-1",
          capabilities: ["carbon.procurement.draft"],
          policyVersion: "v1"
        } as never,
        sourceUrl: "https://carbon.example.test",
        forwardHeaders: envelope(),
        now,
        fetchImpl
      })
    ).rejects.toThrow("Only a verified workforce identity");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a forged actor field before any Carbon write", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeProcurementDraftCommand({
        command: { ...proposal, actorId: "attacker-controlled-user" },
        principal: invoker(["carbon.procurement.draft"]),
        sourceUrl: "https://carbon.example.test",
        forwardHeaders: envelope(),
        now,
        fetchImpl
      })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a verified forwarding envelope", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeProcurementDraftCommand({
        command: proposal,
        principal: invoker(["carbon.procurement.draft"]),
        sourceUrl: "https://carbon.example.test",
        forwardHeaders: new Headers({ authorization: "Bearer token" }),
        now,
        fetchImpl
      })
    ).rejects.toThrow("verified workforce forwarding envelope");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reconciles a lost response by replaying the same idempotency key", async () => {
    const bodies: string[] = [];
    let attempt = 0;
    const result = await executeProcurementDraftCommand({
      command: proposal,
      principal: invoker(["carbon.procurement.draft"]),
      sourceUrl: "https://carbon.example.test",
      forwardHeaders: envelope(),
      now,
      fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body));
        attempt += 1;
        if (attempt === 1) throw new Error("socket hang up");
        return Response.json({ purchaseOrderId: "po-1", replayed: true });
      }
    });

    expect(attempt).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(result).toMatchObject({
      purchaseOrderId: "po-1",
      replayed: true,
      idempotencyKey: "procurement-idempotency-1"
    });
  });

  it("reports a persistently lost response with its retryable key", async () => {
    await expect(
      executeProcurementDraftCommand({
        command: proposal,
        principal: invoker(["carbon.procurement.draft"]),
        sourceUrl: "https://carbon.example.test",
        forwardHeaders: envelope(),
        now,
        fetchImpl: async () => new Response("upstream", { status: 502 })
      })
    ).rejects.toThrow(/procurement-idempotency-1/);
  });

  it("does not retry a refusal", async () => {
    let attempts = 0;
    await expect(
      executeProcurementDraftCommand({
        command: proposal,
        principal: invoker(["carbon.procurement.draft"]),
        sourceUrl: "https://carbon.example.test",
        forwardHeaders: envelope(),
        now,
        fetchImpl: async () => {
          attempts += 1;
          return new Response("forbidden", { status: 403 });
        }
      })
    ).rejects.toThrow("failed with 403");
    expect(attempts).toBe(1);
  });
});
