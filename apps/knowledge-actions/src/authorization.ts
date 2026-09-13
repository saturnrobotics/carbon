import type { Principal } from "@carbon/knowledge";

/**
 * The command-specific capability a caller registration must grant before this
 * service will forward a ticket command. It is deliberately distinct from
 * `knowledge.read`: a query identity that may search every manual has no
 * invocation right here, and the trusted-caller registry never bundles the two.
 */
export const TICKET_CREATE_CAPABILITY = "kanban.ticket.create";

export type TicketCommandInvoker = Extract<Principal, { kind: "human" }>;

export class TicketCommandAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketCommandAuthorizationError";
  }
}

/**
 * Re-authorizes one command invocation. It runs per request, after the
 * workforce assertions were verified for THIS request, so a revoked capability
 * takes effect on the next command rather than for the life of a session.
 */
export function assertTicketCommandInvoker(
  principal: Principal
): TicketCommandInvoker {
  if (principal.kind !== "human") {
    throw new TicketCommandAuthorizationError(
      "Only a verified workforce identity can invoke ticket commands"
    );
  }
  if (!principal.capabilities.includes(TICKET_CREATE_CAPABILITY)) {
    throw new TicketCommandAuthorizationError(
      "Principal cannot create Kanban tickets"
    );
  }
  return principal;
}
