import {
  type ProcurementDraftProposal,
  procurementCommandPayloadHash,
  procurementDraftProposalSchema,
  resolveScheduledExecution
} from "@carbon/knowledge/commands/procurement";

/**
 * What this service sends Carbon for one procurement command. It is a durable
 * command REFERENCE plus its actor — decided on Carbon's side from the verified
 * request identity — and never a credential: no bearer token, IAP assertion or
 * forwarding header is part of it, so nothing that could act as the user later
 * is written down anywhere. A deferred command is re-authorized from scratch at
 * execution time against the actor's permissions as they are then.
 */
export type ScheduledProcurementCommand = {
  idempotencyKey: string;
  payloadHash: string;
  supplierId: string;
  receivingLocationId: string;
  requestedArrivalDate?: string;
  proposedOrderByDate?: string;
  /** Absent means "create the draft now"; present means "create it then". */
  executeAt?: string;
  lines: ProcurementDraftProposal["lines"];
};

/** Field names that would carry authority if they ever reached the wire. */
const CREDENTIAL_FIELDS = [
  "authorization",
  "token",
  "accessToken",
  "idToken",
  "assertion",
  "credential",
  "cookie",
  "bearer",
  "actorId",
  "companyId"
] as const;

/**
 * Turn a validated proposal into the command Carbon stores. The proposal's own
 * `executeAt` and `proposedOrderByDate` decide WHEN, on the business calendar
 * the proposal was authored in — a future order date alone is enough to defer,
 * and a moment already past runs immediately rather than being dropped.
 */
export function buildScheduledProcurementCommand(
  proposal: unknown,
  options: { now: string }
): ScheduledProcurementCommand {
  const parsed = procurementDraftProposalSchema.parse(proposal);
  const execution = resolveScheduledExecution({
    proposedOrderByDate: parsed.proposedOrderByDate,
    executeAt: parsed.executeAt,
    businessTimezone: parsed.businessTimezone,
    now: options.now
  });
  const command: ScheduledProcurementCommand = {
    idempotencyKey: parsed.idempotencyKey,
    payloadHash: procurementCommandPayloadHash({
      supplierId: parsed.supplierId,
      receivingLocationId: parsed.receivingLocationId,
      requestedArrivalDate: parsed.requestedArrivalDate,
      proposedOrderByDate: parsed.proposedOrderByDate,
      lines: parsed.lines
    }),
    supplierId: parsed.supplierId,
    receivingLocationId: parsed.receivingLocationId,
    ...(parsed.requestedArrivalDate
      ? { requestedArrivalDate: parsed.requestedArrivalDate }
      : {}),
    ...(parsed.proposedOrderByDate
      ? { proposedOrderByDate: parsed.proposedOrderByDate }
      : {}),
    ...(execution.mode === "scheduled"
      ? { executeAt: execution.executeAt }
      : {}),
    lines: parsed.lines
  };
  assertNoDurableCredential(command);
  return command;
}

/**
 * A command is persisted by Carbon for as long as it is deferred, so it must
 * not contain anything that could act on the user's behalf, nor an identity
 * claim the caller made about itself. Carbon stamps actor and company from the
 * verified request; a payload asserting either is refused rather than trusted.
 */
export function assertNoDurableCredential(command: object): void {
  const offending = Object.keys(command).filter((key) =>
    CREDENTIAL_FIELDS.some((field) => field.toLowerCase() === key.toLowerCase())
  );
  if (offending.length > 0) {
    throw new Error(
      `A scheduled command may not carry ${offending.join(", ")}`
    );
  }
}
