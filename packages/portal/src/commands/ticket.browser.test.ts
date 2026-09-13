import { describe, expect, it } from "vitest";
import { ticketCommandPayloadHash } from "./ticket";
import {
  assertExecutableTicketCommandBrowser,
  ticketCommandPayloadHashBrowser
} from "./ticket.browser";

const payload = {
  boardId: "board-a",
  initialColumnId: "column-pending",
  title: "Inspect motor",
  description: "",
  dueDate: "2026-09-14",
  businessTimezone: "America/New_York"
};

describe("browser ticket command validator", () => {
  it("uses the same canonical SHA-256 payload identity as the server", async () => {
    const payloadHash = await ticketCommandPayloadHashBrowser(payload);
    expect(payloadHash).toBe(ticketCommandPayloadHash(payload));
    await expect(
      assertExecutableTicketCommandBrowser({
        id: "command-1",
        version: 1,
        action: "kanban.ticket.create",
        target: { sourceId: "kanban-a", resourceId: "board-a" },
        payload,
        payloadHash,
        idempotencyKey: "once"
      })
    ).resolves.toMatchObject({ payload });
  });
});
