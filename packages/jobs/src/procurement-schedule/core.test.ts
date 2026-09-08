import { describe, expect, it, vi } from "vitest";
import { runClaimedProcurementSchedule } from "./core";

const schedule = {
  id: "kps-1",
  companyId: "company-1",
  companyGroupId: "group-1",
  actorId: "user-1",
  payload: {
    idempotencyKey: "command-1",
    payloadHash: "a".repeat(64),
    executeAt: "2026-09-08T12:00:00.000Z"
  }
};

describe("scheduled procurement execution", () => {
  it("cancels a revoked actor before a canonical write can run", async () => {
    const dispatch = vi.fn();
    const settle = vi.fn();
    await expect(
      runClaimedProcurementSchedule(
        schedule,
        { allowed: false, revision: "revoked" },
        dispatch,
        settle
      )
    ).resolves.toEqual({ state: "revoked" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({
      state: "cancelled",
      revision: "revoked",
      failureCode: "actor_permission_revoked"
    });
  });

  it("removes executeAt and settles one PO for concurrent retry claims", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValue({ success: true, data: { purchaseOrderId: "po-1" } });
    const settled: unknown[] = [];
    let claimed = false;
    const once = async () => {
      if (claimed) return { state: "not_due_or_claimed" };
      claimed = true;
      return await runClaimedProcurementSchedule(
        schedule,
        { allowed: true, revision: "p1" },
        dispatch,
        async (outcome) => {
          settled.push(outcome);
        }
      );
    };
    const [first, second] = await Promise.all([once(), once()]);
    expect([first, second]).toContainEqual({
      state: "succeeded",
      purchaseOrderId: "po-1"
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[1]).not.toHaveProperty("executeAt");
    expect(settled).toEqual([
      { state: "succeeded", revision: "p1", purchaseOrderId: "po-1" }
    ]);
  });
});
