import { ticketCommandPayloadHash } from "@carbon/knowledge/commands/ticket";
import { describe, expect, it, vi } from "vitest";

import { handleTicketCommand } from "./server";

const payload = {
  boardId: "board:maintenance",
  initialColumnId: "column:pending",
  title: "Inspect motor",
  description: "Check label.",
  dueDate: "2026-09-14",
  businessTimezone: "America/New_York"
};

const command = {
  id: "command:1",
  version: 1,
  action: "kanban.ticket.create",
  target: { sourceId: "kanban:example", resourceId: "board:maintenance" },
  payload,
  payloadHash: ticketCommandPayloadHash(payload),
  idempotencyKey: "ticket:once"
};

describe("ticket action HTTP handler", () => {
  it("verifies before making the source write and forwards only the verified envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ticket: { id: "ticket:1" },
          ticket_url: "/tickets/ticket:1",
          replayed: false
        }),
        { status: 201 }
      )
    );
    const response = await handleTicketCommand(
      new Request("https://actions.example.test/commands/tickets", {
        method: "POST",
        body: JSON.stringify(command)
      }),
      {
        sourceId: "kanban:example",
        sourceUrl: "https://kanban.example.test",
        fetchImpl,
        verifyWorkforce: vi.fn().mockResolvedValue({
          principal: {
            kind: "human",
            actorId: "user:1",
            companyId: "company:1",
            callerId: "knowledge-actions",
            sourceIdentity: {
              issuer: "https://cloud.google.com/iap",
              subject: "subject:1"
            },
            policyVersion: "policy:1",
            capabilities: ["kanban.ticket.create"]
          }
        }),
        forwardingHeaders: vi.fn().mockResolvedValue(
          new Headers({
            authorization: "Bearer fresh",
            "x-portal-user-evidence": "original-iap"
          })
        )
      }
    );
    expect(response.status).toBe(201);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(
      fetchImpl.mock.calls[0]?.[1].headers.get("x-portal-user-evidence")
    ).toBe("original-iap");
  });

  it("does not invoke Kanban when workforce verification fails", async () => {
    const fetchImpl = vi.fn();
    const response = await handleTicketCommand(
      new Request("https://actions.example.test/commands/tickets", {
        method: "POST",
        body: JSON.stringify(command)
      }),
      {
        sourceId: "kanban:example",
        sourceUrl: "https://kanban.example.test",
        fetchImpl,
        verifyWorkforce: vi.fn().mockRejectedValue(new Error("bad identity")),
        forwardingHeaders: vi.fn()
      }
    );
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
