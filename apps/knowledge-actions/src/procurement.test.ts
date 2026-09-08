import { describe, expect, it, vi } from "vitest";
import { executeProcurementDraftCommand } from "./procurement";

const proposal = {
  id: "procurement-proposal-1",
  version: 1,
  action: "carbon.procurement.draft",
  idempotencyKey: "procurement-idempotency-1",
  supplierId: "supplier-1",
  receivingLocationId: "location-1",
  proposedOrderByDate: "2026-09-09",
  businessTimezone: "America/New_York",
  lines: [
    {
      itemId: "PART-100",
      itemRevisionId: "item-revision-1",
      quantity: "2",
      purchaseUnitOfMeasureCode: "BOX",
      inventoryUnitOfMeasureCode: "EA",
      conversionFactor: "10",
      supplierUnitPrice: "1.25"
    }
  ]
};

describe("executeProcurementDraftCommand", () => {
  it("forwards only a server-verified command with a deterministic payload hash", async () => {
    const requests: RequestInit[] = [];
    const result = await executeProcurementDraftCommand({
      command: proposal,
      principal: {
        kind: "human",
        actorId: "user-1",
        companyId: "company-1",
        callerId: "iap:subject-1",
        sourceIdentity: {
          issuer: "https://issuer.example.test",
          subject: "subject-1"
        },
        capabilities: ["carbon.procurement.draft"],
        policyVersion: "v1"
      },
      sourceUrl: "https://carbon.example.test/",
      forwardHeaders: new Headers({
        authorization: "Bearer verified-service-token",
        "x-portal-user-evidence": "verified-iap"
      }),
      fetchImpl: async (_url, init) => {
        requests.push(init!);
        return Response.json({ scheduleId: "kps-1", replayed: false });
      }
    });

    expect(result).toEqual({ scheduleId: "kps-1", replayed: false });
    const body = JSON.parse(String(requests[0]?.body));
    expect(body.args.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.args).not.toHaveProperty("actorId");
    expect(body.args).not.toHaveProperty("companyId");
  });

  it("refuses a principal without the exact procurement capability", async () => {
    await expect(
      executeProcurementDraftCommand({
        command: proposal,
        principal: {
          kind: "human",
          actorId: "user-1",
          companyId: "company-1",
          callerId: "iap:subject-1",
          sourceIdentity: {
            issuer: "https://issuer.example.test",
            subject: "subject-1"
          },
          capabilities: [],
          policyVersion: "v1"
        },
        sourceUrl: "https://carbon.example.test",
        forwardHeaders: new Headers({
          authorization: "Bearer verified-service-token",
          "x-portal-user-evidence": "verified-iap"
        })
      })
    ).rejects.toThrow("cannot create procurement drafts");
  });

  it("rejects a forged actor field before a Carbon write", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeProcurementDraftCommand({
        command: { ...proposal, actorId: "attacker-controlled-user" },
        principal: {
          kind: "human",
          actorId: "user-1",
          companyId: "company-1",
          callerId: "iap:subject-1",
          sourceIdentity: {
            issuer: "https://issuer.example.test",
            subject: "subject-1"
          },
          capabilities: ["carbon.procurement.draft"],
          policyVersion: "v1"
        },
        sourceUrl: "https://carbon.example.test",
        forwardHeaders: new Headers({
          authorization: "Bearer verified-service-token",
          "x-portal-user-evidence": "verified-iap"
        }),
        fetchImpl
      })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
