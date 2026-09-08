import type { DispatchResult } from "../workflows/actions/dispatcher";

export type ProcurementScheduleDispatchContext = {
  companyId: string;
  companyGroupId: string;
  userId: string;
};

export type ProcurementScheduleDispatch = (
  context: ProcurementScheduleDispatchContext,
  payload: Record<string, unknown>
) => Promise<DispatchResult>;

let dispatch: ProcurementScheduleDispatch | undefined;

/** Filled only by ERP's Inngest entry point. Jobs never import ERP services. */
export function setProcurementScheduleDispatch(
  fn: ProcurementScheduleDispatch
): void {
  dispatch = fn;
}

export function getProcurementScheduleDispatch():
  | ProcurementScheduleDispatch
  | undefined {
  return dispatch;
}
