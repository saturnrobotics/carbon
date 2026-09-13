import type { Principal } from "@carbon/knowledge";
import {
  assertExecutableTicketCommand,
  type ExecutableTicketCommand
} from "@carbon/knowledge/commands/ticket";

import { assertTicketCommandInvoker } from "./authorization";

/** One source round-trip may not outlive the caller's own request budget. */
export const SOURCE_REQUEST_TIMEOUT_MS = 10_000;

export type TicketCommandResult = {
  ticketUrl: string;
  ticket: SourceTicket;
  replayed: boolean;
  /** What the source actually committed, for the reader to confirm against. */
  effective: {
    ticketId: string;
    boardId: string;
    columnId: string;
    title: string;
    dueDate: string | null;
  };
};

type SourceTicket = {
  id: string;
  board_id: string;
  column_id: string;
  title: string;
  due_date: string | null;
} & Record<string, unknown>;

type SourceResult = {
  ticket: SourceTicket;
  ticket_url: string;
  replayed: boolean;
};

function isSourceTicket(value: unknown): value is SourceTicket {
  if (!value || typeof value !== "object") return false;
  const ticket = value as Record<string, unknown>;
  return (
    typeof ticket.id === "string" &&
    typeof ticket.board_id === "string" &&
    typeof ticket.column_id === "string" &&
    typeof ticket.title === "string" &&
    (ticket.due_date === null || typeof ticket.due_date === "string")
  );
}

async function parseSourceResult(response: Response): Promise<SourceResult> {
  const value = (await response.json()) as Partial<SourceResult> | null;
  if (
    !value ||
    !isSourceTicket(value.ticket) ||
    typeof value.ticket_url !== "string" ||
    typeof value.replayed !== "boolean"
  ) {
    throw new Error("Kanban returned an unrecognized command result");
  }
  return value as SourceResult;
}

function toResult(source: SourceResult): TicketCommandResult {
  return {
    ticket: source.ticket,
    ticketUrl: source.ticket_url,
    replayed: source.replayed,
    effective: {
      ticketId: source.ticket.id,
      boardId: source.ticket.board_id,
      columnId: source.ticket.column_id,
      title: source.ticket.title,
      dueDate: source.ticket.due_date
    }
  };
}

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
  principal: Principal;
  sourceId: string;
  sourceUrl: string;
  fetchImpl?: typeof fetch;
  forwardHeaders: Headers;
  payloadHash?: (payload: ExecutableTicketCommand["payload"]) => string;
}): Promise<TicketCommandResult> {
  assertTicketCommandInvoker(principal);
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
  const base = sourceUrl.replace(/\/$/, "");
  const headers = new Headers(forwardHeaders);
  headers.set("content-type", "application/json");
  let response: Response | undefined;
  try {
    response = await fetchImpl(`${base}/api/commands/tickets`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...executable.payload,
        idempotencyKey: executable.idempotencyKey
      }),
      signal: AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS)
    });
  } catch {
    // A lost response is not a lost command: the source may have committed.
    // Its actor-scoped receipt is the only authority on that, so reconcile
    // from it rather than guessing or re-sending a possibly duplicate write.
  }
  if (response?.ok) return toResult(await parseSourceResult(response));
  if (response && response.status < 500) {
    throw new Error(`Kanban ticket command failed with ${response.status}`);
  }
  return toResult(
    await recoverTicketCommand({
      base,
      forwardHeaders,
      fetchImpl,
      idempotencyKey: executable.idempotencyKey
    })
  );
}

/**
 * Reads the source receipt for this actor + key. 200 means the command
 * committed and its result is authoritative; 404 means it never committed and
 * the same command may be safely resent with the same key.
 */
async function recoverTicketCommand(options: {
  base: string;
  forwardHeaders: Headers;
  fetchImpl: typeof fetch;
  idempotencyKey: string;
}): Promise<SourceResult> {
  const response = await options.fetchImpl(
    `${options.base}/api/commands/tickets/${encodeURIComponent(options.idempotencyKey)}`,
    {
      method: "GET",
      headers: new Headers(options.forwardHeaders),
      signal: AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS)
    }
  );
  if (response.status === 404) {
    throw new Error(
      "Kanban ticket command did not commit; retry with the same idempotency key"
    );
  }
  if (!response.ok) {
    throw new Error(
      `Kanban ticket command receipt lookup failed with ${response.status}`
    );
  }
  const recovered = await parseSourceResult(response);
  return { ...recovered, replayed: true };
}
