import { ticketCommandPayloadHash } from "@carbon/portal/commands/ticket";
import { afterEach, describe, expect, it, vi } from "vitest";

import { action, forwardTicketCommand } from "./api.commands";

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
      new Request("https://portal.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://portal.example.test" },
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
            callerId: "portal-web",
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
      new Request("https://portal.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://portal.example.test" },
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
      new Request("https://portal.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://portal.example.test" },
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
      new Request("https://portal.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://portal.example.test" },
        body: JSON.stringify({
          ...proposal,
          clarification: { field: "boardId", choices: ["board:maintenance"] }
        })
      }),
      dependencies
    );
    expect(unresolved.status).toBe(422);
    const crossOrigin = await forwardTicketCommand(
      new Request("https://portal.example.test/api/commands", {
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

/**
 * The route's own `action`, which no browser test can reach: `routes.ts` is the
 * production manifest and the approved manual-v1 profile defers this module, so
 * every built image answers `/api/commands` from the catch-all
 * (`tests/ticket-command.spec.ts` pins that). These cover the refusal a profile
 * that DID register the route would produce, which is otherwise untested.
 *
 * `release.py` admits neither `PORTAL_ACTIONS_URL` nor
 * `PORTAL_ACTIONS_AUDIENCE` on a `portal-web` revision, so 503 is the only
 * answer a release could give even after the route is registered.
 */
describe("ticket command route action", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses with 503 until an actions service is configured", async () => {
    for (const absent of [
      "PORTAL_ACTIONS_URL",
      "PORTAL_ACTIONS_AUDIENCE",
      "PORTAL_COMPANY_ID"
    ]) {
      vi.stubEnv("PORTAL_ACTIONS_URL", "https://actions.example.test");
      vi.stubEnv("PORTAL_ACTIONS_AUDIENCE", "actions-audience");
      vi.stubEnv("PORTAL_COMPANY_ID", "company:1");
      vi.stubEnv(absent, "");
      const response = await action({
        request: new Request("https://portal.example.test/api/commands", {
          method: "POST",
          headers: { origin: "https://portal.example.test" },
          body: JSON.stringify(proposal)
        })
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "ticket_commands_not_configured"
      });
    }
  });

  it("hands a configured request to the gateway, which applies its own guards", async () => {
    vi.stubEnv("PORTAL_ACTIONS_URL", "https://actions.example.test");
    vi.stubEnv("PORTAL_ACTIONS_AUDIENCE", "actions-audience");
    vi.stubEnv("PORTAL_COMPANY_ID", "company:1");
    // A foreign origin is refused by `forwardTicketCommand` before any
    // identity or network work, so this proves delegation without a stub.
    const response = await action({
      request: new Request("https://portal.example.test/api/commands", {
        method: "POST",
        headers: { origin: "https://elsewhere.example.test" },
        body: JSON.stringify(proposal)
      })
    });
    expect(response.status).toBe(403);
  });
});
