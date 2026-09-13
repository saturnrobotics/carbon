import { ticketCommandPayloadHash } from "@carbon/portal/commands/ticket";
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

const command = {
  id: "command:1",
  version: 1,
  action: "kanban.ticket.create",
  target: { sourceId: "kanban:example", resourceId: "board:maintenance" },
  payload,
  payloadHash: ticketCommandPayloadHash(payload),
  idempotencyKey: "ticket:once"
};

const principal = {
  kind: "human" as const,
  actorId: "user:1",
  companyId: "company:1",
  callerId: "portal-actions",
  sourceIdentity: { issuer: "https://example.com", subject: "subject:1" },
  policyVersion: "policy:1",
  capabilities: ["kanban.ticket.create"]
};

const forwardHeaders = () =>
  new Headers({
    authorization: "Bearer delegated",
    "x-portal-user-evidence": "iap-evidence"
  });

const sourceTicket = {
  id: "ticket:1",
  board_id: "board:maintenance",
  column_id: "column:pending",
  title: "Inspect motor",
  due_date: "2026-09-14"
};

function sourceResult(replayed = false, status = replayed ? 200 : 201) {
  return new Response(
    JSON.stringify({
      ticket: sourceTicket,
      ticket_url: "/tickets/ticket:1",
      replayed
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

describe("portal action ticket execution", () => {
  it("forwards only a validated source payload after a capability-checked principal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sourceResult());
    const result = await executeTicketCommand({
      command,
      principal,
      sourceId: "kanban:example",
      sourceUrl: "https://kanban.example.test",
      fetchImpl,
      forwardHeaders: forwardHeaders(),
      payloadHash: ticketCommandPayloadHash
    });
    expect(result.ticketUrl).toBe("/tickets/ticket:1");
    expect(result.replayed).toBe(false);
    expect(result.effective).toEqual({
      ticketId: "ticket:1",
      boardId: "board:maintenance",
      columnId: "column:pending",
      title: "Inspect motor",
      dueDate: "2026-09-14"
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://kanban.example.test/api/commands/tickets",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey: "ticket:once" })
      })
    );
  });

  it("refuses a read-only query identity before any source call", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeTicketCommand({
        command,
        principal: { ...principal, capabilities: ["portal.read"] },
        sourceId: "kanban:example",
        sourceUrl: "https://kanban.example.test",
        fetchImpl,
        forwardHeaders: forwardHeaders()
      })
    ).rejects.toThrow(/cannot create/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a command aimed at a source other than the registered Kanban", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeTicketCommand({
        command: {
          ...command,
          target: { ...command.target, sourceId: "kanban:other" }
        },
        principal,
        sourceId: "kanban:example",
        sourceUrl: "https://kanban.example.test",
        fetchImpl,
        forwardHeaders: forwardHeaders()
      })
    ).rejects.toThrow(/registered Kanban source/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("recovers a lost response from the actor-scoped receipt instead of re-sending", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(sourceResult(true));
    const result = await executeTicketCommand({
      command,
      principal,
      sourceId: "kanban:example",
      sourceUrl: "https://kanban.example.test/",
      fetchImpl,
      forwardHeaders: forwardHeaders()
    });
    expect(result.replayed).toBe(true);
    expect(result.effective.ticketId).toBe("ticket:1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://kanban.example.test/api/commands/tickets/ticket%3Aonce"
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("reports an uncommitted command as retryable when the receipt is absent", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      executeTicketCommand({
        command,
        principal,
        sourceId: "kanban:example",
        sourceUrl: "https://kanban.example.test",
        fetchImpl,
        forwardHeaders: forwardHeaders()
      })
    ).rejects.toThrow(/did not commit/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a source refusal without attempting recovery", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("changed payload", { status: 409 }));
    await expect(
      executeTicketCommand({
        command,
        principal,
        sourceId: "kanban:example",
        sourceUrl: "https://kanban.example.test",
        fetchImpl,
        forwardHeaders: forwardHeaders()
      })
    ).rejects.toThrow(/409/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
