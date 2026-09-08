import type { ProcurementScheduleDispatch } from "./dispatcher";

export type ClaimedProcurementSchedule = {
  id: string;
  companyId: string;
  companyGroupId: string;
  actorId: string;
  payload: unknown;
};

export type ProcurementAuthorization = {
  allowed: boolean;
  revision: string | null;
};

export function executablePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scheduled procurement payload is invalid");
  }
  const { executeAt: _scheduledFor, ...executable } = value as Record<
    string,
    unknown
  >;
  return executable;
}

export async function runClaimedProcurementSchedule(
  schedule: ClaimedProcurementSchedule,
  authorization: ProcurementAuthorization,
  dispatch: ProcurementScheduleDispatch,
  settle: (outcome: {
    state: "cancelled" | "succeeded";
    revision: string | null;
    failureCode?: "actor_permission_revoked" | "proposal_no_longer_executable";
    purchaseOrderId?: string;
  }) => Promise<void>
) {
  if (!authorization.allowed) {
    await settle({
      state: "cancelled",
      revision: authorization.revision,
      failureCode: "actor_permission_revoked"
    });
    return { state: "revoked" as const };
  }
  const result = await dispatch(
    {
      companyId: schedule.companyId,
      companyGroupId: schedule.companyGroupId,
      userId: schedule.actorId
    },
    executablePayload(schedule.payload)
  );
  if (!result.success) {
    await settle({
      state: "cancelled",
      revision: authorization.revision,
      failureCode: "proposal_no_longer_executable"
    });
    return { state: "rejected" as const };
  }
  const data = result.data as { purchaseOrderId?: unknown } | undefined;
  if (typeof data?.purchaseOrderId !== "string") {
    throw new Error("Canonical procurement command returned no purchase order");
  }
  await settle({
    state: "succeeded",
    revision: authorization.revision,
    purchaseOrderId: data.purchaseOrderId
  });
  return { state: "succeeded" as const, purchaseOrderId: data.purchaseOrderId };
}
