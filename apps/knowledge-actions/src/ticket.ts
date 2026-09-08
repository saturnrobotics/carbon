import type { Principal } from "@carbon/knowledge";
import {
  assertExecutableTicketCommand,
  type ExecutableTicketCommand
} from "@carbon/knowledge/commands/ticket";

type HumanPrincipal = Extract<Principal, { kind: "human" }>;

export async function executeTicketCommand({
  command,
  principal,
  sourceId,
  sourceUrl,
  fetchImpl = fetch,
  forwardHeaders,
  payloadHash
}: {
  command: unknown;
  principal: HumanPrincipal;
  sourceId: string;
  sourceUrl: string;
  fetchImpl?: typeof fetch;
  forwardHeaders: Headers;
  payloadHash?: (payload: ExecutableTicketCommand["payload"]) => string;
}): Promise<{ ticketUrl: string; ticket: unknown; replayed: boolean }> {
  if (!principal.capabilities.includes("kanban.ticket.create")) {
    throw new Error("Principal cannot create Kanban tickets");
  }
  const executable = assertExecutableTicketCommand(command);
  if (executable.target.sourceId !== sourceId) {
    throw new Error(
      "Ticket command target is not the registered Kanban source"
    );
  }
  if (
    payloadHash &&
    payloadHash(executable.payload) !== executable.payloadHash
  ) {
    throw new Error("Ticket command payload hash does not match its payload");
  }
  if (
    !forwardHeaders.get("authorization") ||
    !forwardHeaders.get("x-portal-user-evidence")
  ) {
    throw new Error("A verified workforce forwarding envelope is required");
  }
  const headers = new Headers(forwardHeaders);
  headers.set("content-type", "application/json");
  const response = await fetchImpl(
    `${sourceUrl.replace(/\/$/, "")}/api/commands/tickets`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...executable.payload,
        idempotencyKey: executable.idempotencyKey
      })
    }
  );
  if (!response.ok)
    throw new Error(`Kanban ticket command failed with ${response.status}`);
  const result = (await response.json()) as {
    ticket: unknown;
    ticket_url: string;
    replayed: boolean;
  };
  return {
    ticket: result.ticket,
    ticketUrl: result.ticket_url,
    replayed: result.replayed
  };
}
