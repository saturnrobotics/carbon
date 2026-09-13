import { createHash } from "node:crypto";

import { type CommandProposal, commandProposalSchema } from "../contracts";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function ticketCommandPayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export type ExecutableTicketCommand = Extract<
  CommandProposal,
  { action: "kanban.ticket.create" }
>;

export function assertExecutableTicketCommand(
  input: unknown
): ExecutableTicketCommand {
  const command = commandProposalSchema.parse(input);
  if (command.action !== "kanban.ticket.create") {
    throw new Error("Expected a kanban.ticket.create command");
  }
  if (command.clarification) {
    throw new Error("Ticket command has unresolved clarification");
  }
  if (ticketCommandPayloadHash(command.payload) !== command.payloadHash) {
    throw new Error("Ticket command payload hash does not match its payload");
  }
  return command;
}
