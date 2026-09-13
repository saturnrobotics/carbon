import { describe, expect, it } from "vitest";

import {
  assertExecutableTicketCommand,
  ticketCommandPayloadHash
} from "./ticket";

const payload = {
  boardId: "board:maintenance",
  initialColumnId: "column:pending",
  title: "Inspect motor",
  description: "Check label.",
  dueDate: "2026-09-14",
  businessTimezone: "America/New_York"
};

const payloadHash = ticketCommandPayloadHash(payload);

describe("ticket commands", () => {
  it("accepts only a complete, hash-matched ticket command", () => {
    expect(
      assertExecutableTicketCommand({
        id: "command:ticket:1",
        version: 1,
        action: "kanban.ticket.create",
        target: { sourceId: "kanban:example", resourceId: "board:maintenance" },
        payload,
        payloadHash,
        idempotencyKey: "ticket:once"
      })
    ).toMatchObject({ payload });
  });

  it("rejects a changed payload and unresolved clarification", () => {
    expect(() =>
      assertExecutableTicketCommand({
        id: "command:ticket:1",
        version: 1,
        action: "kanban.ticket.create",
        target: { sourceId: "kanban:example", resourceId: "board:maintenance" },
        payload: { ...payload, title: "Different" },
        payloadHash,
        idempotencyKey: "ticket:once"
      })
    ).toThrow(/hash/i);
  });
});
