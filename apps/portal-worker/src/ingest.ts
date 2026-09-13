import type { IntakeInput } from "@carbon/portal/intake";
import { type CapturedIntake, captureIdentity } from "@carbon/portal/intake";
import { validateFetchUrl } from "./fetch-policy";

export function captureIngest(
  input: Omit<CapturedIntake, "idempotencyKey" | "state">
): CapturedIntake {
  if (input.input.kind === "url") validateFetchUrl(input.input.url);
  return captureIdentity(input);
}

export type { IntakeInput };
