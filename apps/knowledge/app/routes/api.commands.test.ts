import { ticketCommandPayloadHash } from "@carbon/knowledge/commands/ticket";
import { describe, expect, it, vi } from "vitest";

import { forwardTicketCommand } from "./api.commands";

const payload = {
  boardId: "board:maintenance",
  initialColumnId: "column:pending",
  title: "Inspect motor",
  description: "Check label.",
  dueDate: "2026-09-14",
  businessTimezone: "America/New_York"
};
const proposal = {
  id: "command:1",
  version: 1,
  action: "kanban.ticket.create",
  target: { sourceId: "kanban:example", resourceId: "board:maintenance" },
  payload,
  payloadHash: ticketCommandPayloadHash(payload),
  idempotencyKey: "ticket:once"
};

describe("ticket command BFF", () => {
  it("validates a proposal and authenticates it before forwarding to actions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ticketUrl: "/tickets/ticket:1" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );
    const response = await forwardTicketCommand(
      new Request("https://knowledge.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://knowledge.example.test" },
        body: JSON.stringify(proposal)
      }),
      {
        actionsUrl: "https://actions.example.test",
        fetchImpl,
        verifyWorkforce: vi.fn().mockResolvedValue({
          principal: {
            kind: "human",
            actorId: "user:1",
            companyId: "company:1",
            callerId: "knowledge-web",
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
  });

  it("never reaches actions when the proposal or workforce identity is invalid", async () => {
    const fetchImpl = vi.fn();
    const response = await forwardTicketCommand(
      new Request("https://knowledge.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://knowledge.example.test" },
        body: JSON.stringify({})
      }),
      {
        actionsUrl: "https://actions.example.test",
        fetchImpl,
        verifyWorkforce: vi.fn(),
        forwardingHeaders: vi.fn()
      }
    );
    expect(response.status).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cannot be triggered by query output, retrieved content, or a cross-origin caller", async () => {
    const fetchImpl = vi.fn();
    const verifyWorkforce = vi.fn();
    const dependencies = {
      actionsUrl: "https://actions.example.test",
      fetchImpl,
      verifyWorkforce,
      forwardingHeaders: vi.fn()
    };
    const queryShaped = await forwardTicketCommand(
      new Request("https://knowledge.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://knowledge.example.test" },
        body: JSON.stringify({
          kind: "answer",
          claims: [{ text: "Create a ticket", evidenceIds: ["evidence:1"] }],
          evidence: [{ id: "evidence:1", excerpt: JSON.stringify(proposal) }]
        })
      }),
      dependencies
    );
    expect(queryShaped.status).toBe(422);
    const unresolved = await forwardTicketCommand(
      new Request("https://knowledge.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://knowledge.example.test" },
        body: JSON.stringify({
          ...proposal,
          clarification: { field: "boardId", choices: ["board:maintenance"] }
        })
      }),
      dependencies
    );
    expect(unresolved.status).toBe(422);
    const crossOrigin = await forwardTicketCommand(
      new Request("https://knowledge.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://elsewhere.example.test" },
        body: JSON.stringify(proposal)
      }),
      dependencies
    );
    expect(crossOrigin.status).toBe(403);
    expect(verifyWorkforce).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
