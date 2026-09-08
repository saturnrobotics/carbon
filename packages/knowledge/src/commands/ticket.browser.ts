import { type CommandProposal, commandProposalSchema } from "../contracts";

type TicketCommand = Extract<
  CommandProposal,
  { action: "kanban.ticket.create" }
>;

function canonicalPayload(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalPayload(record[key])}`)
    .join(",")}}`;
}

export async function ticketCommandPayloadHashBrowser(
  payload: TicketCommand["payload"]
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalPayload(payload))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function assertExecutableTicketCommandBrowser(
  input: unknown
): Promise<TicketCommand> {
  const command = commandProposalSchema.parse(input);
  if (command.action !== "kanban.ticket.create")
    throw new Error("Expected a kanban.ticket.create command");
  if (command.clarification)
    throw new Error("Ticket command has unresolved clarification");
  if (
    (await ticketCommandPayloadHashBrowser(command.payload)) !==
    command.payloadHash
  ) {
    throw new Error("Ticket command payload hash does not match its payload");
  }
  return command;
}
