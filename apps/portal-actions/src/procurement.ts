import type { Principal } from "@carbon/portal";
import { buildScheduledProcurementCommand } from "./scheduled";

/**
 * The command-specific capability a caller registration must grant before this
 * service will forward a procurement command. Deliberately distinct from
 * `portal.read`: an identity that may read every supplier price has no right
 * to create a purchase order, and the trusted-caller registry never bundles the
 * two.
 */
export const PROCUREMENT_DRAFT_CAPABILITY = "carbon.procurement.draft";

export type ProcurementCommandInvoker = Extract<Principal, { kind: "human" }>;

export class ProcurementCommandAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcurementCommandAuthorizationError";
  }
}

/**
 * Re-authorizes one command invocation, per request, after this request's own
 * workforce assertions were verified — so a revoked capability takes effect on
 * the next command rather than for the life of a session. A machine principal
 * can never invoke: indexing has no business creating purchase orders.
 */
export function assertProcurementCommandInvoker(
  principal: Principal
): ProcurementCommandInvoker {
  if (principal.kind !== "human") {
    throw new ProcurementCommandAuthorizationError(
      "Only a verified workforce identity can invoke procurement commands"
    );
  }
  if (!principal.capabilities.includes(PROCUREMENT_DRAFT_CAPABILITY)) {
    throw new ProcurementCommandAuthorizationError(
      "Principal cannot create procurement drafts"
    );
  }
  return principal;
}

export type ProcurementCommandOutcome = {
  /** Present once Carbon has created the Draft purchase order. */
  purchaseOrderId?: string;
  /** Present while the command is deferred to its own moment. */
  scheduleId?: string;
  executeAt?: string;
  status?: string;
  replayed: boolean;
  /** The command's identity, so a caller can reconcile a lost response. */
  idempotencyKey: string;
};

type CarbonCommandResponse = {
  purchaseOrderId?: unknown;
  scheduleId?: unknown;
  executeAt?: unknown;
  status?: unknown;
  replayed?: unknown;
};

function carbonEndpoint(sourceUrl: string): string {
  return `${sourceUrl.replace(/\/$/, "")}/api/v1/portal/createProcurementDraft`;
}

function outcome(
  body: CarbonCommandResponse,
  idempotencyKey: string
): ProcurementCommandOutcome {
  return {
    ...(typeof body.purchaseOrderId === "string"
      ? { purchaseOrderId: body.purchaseOrderId }
      : {}),
    ...(typeof body.scheduleId === "string"
      ? { scheduleId: body.scheduleId }
      : {}),
    ...(typeof body.executeAt === "string"
      ? { executeAt: body.executeAt }
      : {}),
    ...(typeof body.status === "string" ? { status: body.status } : {}),
    replayed: body.replayed === true,
    idempotencyKey
  };
}

/**
 * Forward one verified procurement command to Carbon's canonical API. Nothing
 * here writes a purchase order: Carbon's operation owns the transaction, the
 * permission recheck and the idempotency receipt, so this service cannot create
 * a draft by another route.
 *
 * A LOST response — connection dropped, timeout, 5xx — is reconciled rather
 * than guessed: the identical command is sent once more under the same
 * idempotency key, and Carbon's receipt turns that into a replay of the
 * original rather than a second order. Anything else (a 4xx) is a decision, not
 * a loss, and is reported as-is.
 */
export async function executeProcurementDraftCommand({
  command,
  principal,
  sourceUrl,
  forwardHeaders,
  fetchImpl = fetch,
  now
}: {
  command: unknown;
  principal: Principal;
  sourceUrl: string;
  forwardHeaders: Headers;
  fetchImpl?: typeof fetch;
  /** The instant the request is being handled, for date resolution. */
  now: string;
}): Promise<ProcurementCommandOutcome> {
  assertProcurementCommandInvoker(principal);
  const scheduled = buildScheduledProcurementCommand(command, { now });
  if (
    !forwardHeaders.get("authorization") ||
    !forwardHeaders.get("x-portal-user-evidence")
  ) {
    throw new Error("A verified workforce forwarding envelope is required");
  }
  const headers = new Headers(forwardHeaders);
  headers.set("content-type", "application/json");
  const request = {
    method: "POST",
    headers,
    body: JSON.stringify({ args: scheduled })
  } satisfies RequestInit;

  let lost: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(carbonEndpoint(sourceUrl), request);
    } catch (error) {
      lost = error;
      continue;
    }
    if (response.status >= 500) {
      lost = new Error(
        `Carbon procurement command failed with ${response.status}`
      );
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Carbon procurement command failed with ${response.status}`
      );
    }
    return outcome(
      (await response.json()) as CarbonCommandResponse,
      scheduled.idempotencyKey
    );
  }
  throw new Error(
    `Carbon procurement command response was lost; it can be retried under idempotency key ${scheduled.idempotencyKey}: ${
      lost instanceof Error ? lost.message : "unknown transport failure"
    }`
  );
}
