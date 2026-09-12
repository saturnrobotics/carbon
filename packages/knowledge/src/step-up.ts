/**
 * The structured denial a receiver returns when a delegated request reaches a
 * company that requires Carbon MFA and the request cannot prove it. Every hop
 * between the Carbon API and the browser recognises the same code, so the
 * knowledge web can show "sign in to Carbon with two-factor" instead of a
 * generic failure. Nothing here grants anything: it only names the denial.
 */
export const STEP_UP_REQUIRED_CODE = "step_up_required";

/** Thrown by a source transport when the upstream receiver answered with the step-up denial. */
export class StepUpRequiredError extends Error {
  override readonly name = "StepUpRequiredError";

  constructor() {
    super("Carbon sign-in with two-factor authentication is required");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recognises the step-up denial in either wire shape: the Carbon API's oRPC
 * error envelope (`{ code: "FORBIDDEN", data: { code: "step_up_required" } }`)
 * and the knowledge services' own `{ error: "step_up_required" }`.
 */
export function isStepUpRequiredBody(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.error === STEP_UP_REQUIRED_CODE) return true;
  return isObject(value.data) && value.data.code === STEP_UP_REQUIRED_CODE;
}

/** The knowledge services' response for a step-up denial received from a source. */
export function stepUpRequiredResponse(): Response {
  return Response.json(
    { error: STEP_UP_REQUIRED_CODE },
    { status: 403, headers: { "cache-control": "no-store" } }
  );
}
