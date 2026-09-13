import { parseAbsolute } from "@internationalized/date";
import { z } from "zod";
import type { SourceOutcome } from "./contract";
import { SourceTransportError } from "./http.server";

/** Freshness rule for live source facts (plan §1.8): at most 15 seconds. */
export const SOURCE_FACT_VALIDITY_SECONDS = 15;

/**
 * Maps a failed source call to a structured outcome. A denial is
 * `insufficient-permission`, never `not-found`; anything that did not complete
 * is `unavailable` with its reason, never an empty result.
 */
export function outcomeFromError(error: unknown): SourceOutcome {
  if (error instanceof SourceTransportError) {
    if (error.reason === "denied") return { kind: "insufficient-permission" };
    if (error.reason === "deadline")
      return { kind: "unavailable", reason: "deadline" };
    if (error.reason === "unregistered")
      return { kind: "unavailable", reason: "unregistered" };
    return { kind: "unavailable", reason: "source-error" };
  }
  if (error instanceof z.ZodError)
    return { kind: "unavailable", reason: "source-error" };
  return { kind: "unavailable", reason: "transport" };
}

/** `validUntil` for a live fact: observed time plus the freshness rule. */
export function factValidUntil(observedAt: string): string {
  return parseAbsolute(observedAt, "UTC")
    .add({ seconds: SOURCE_FACT_VALIDITY_SECONDS })
    .toAbsoluteString();
}
