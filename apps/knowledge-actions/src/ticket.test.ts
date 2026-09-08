import { ticketCommandPayloadHash } from "@carbon/knowledge/commands/ticket";
import { describe, expect, it, vi } from "vitest";

import { executeTicketCommand } from "./ticket";

const payload = {
  boardId: "board:maintenance",
  initialColumnId: "column:pending",
  title: "Inspect motor",
  description: "Check label.",
  dueDate: "2026-09-14",
  businessTimezone: "America/New_York"
};

describe("knowledge action ticket execution", () => {
  it("forwards only a validated source payload after a capability-checked principal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ticket: { id: "ticket:1" },
          ticket_url: "/tickets/ticket:1"
        }),
        { status: 201 }
      )
    );
    const result = await executeTicketCommand({
      command: {
        id: "command:1",
        version: 1,
        action: "kanban.ticket.create",
        target: { sourceId: "kanban:example", resourceId: "board:maintenance" },
        payload,
        payloadHash: ticketCommandPayloadHash(payload),
        idempotencyKey: "ticket:once"
      },
      principal: {
        kind: "human",
        actorId: "user:1",
        companyId: "company:1",
        callerId: "knowledge-actions",
        sourceIdentity: { issuer: "https://example.com", subject: "subject:1" },
        policyVersion: "policy:1",
        capabilities: ["kanban.ticket.create"]
      },
      sourceId: "kanban:example",
      sourceUrl: "https://kanban.example.test",
      fetchImpl,
      forwardHeaders: new Headers({
        authorization: "Bearer delegated",
        "x-portal-user-evidence": "iap-evidence"
      }),
      payloadHash: ticketCommandPayloadHash
    });
    expect(result.ticketUrl).toBe("/tickets/ticket:1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://kanban.example.test/api/commands/tickets",
      expect.objectContaining({
        body: JSON.stringify({ ...payload, idempotencyKey: "ticket:once" })
      })
    );
  });
});
