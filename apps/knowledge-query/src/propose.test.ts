import { describe, expect, it, vi } from "vitest";
import { createCommandProposalHandler } from "./propose.server";

const identity = {
  principal: {
    kind: "human",
    actorId: "alice",
    companyId: "company-a",
    callerId: "knowledge-web",
    sourceIdentity: {
      issuer: "https://cloud.google.com/iap",
      subject: "google-alice"
    },
    policyVersion: "policy-1",
    capabilities: ["knowledge.read", "kanban.ticket.create"]
  }
} as never;
const sources = {
  version: 1 as const,
  sources: [
    {
      id: "kanban-a",
      kind: "kanban" as const,
      origin: "https://kanban.example",
      audience: "kanban-audience"
    }
  ]
};
const catalog = {
  sourceRevision: "kanban:workspace:7",
  observedAt: "2026-09-07T12:00:00.000Z",
  partial: false,
  boards: [{ id: "board-maintenance", name: "Maintenance", archivedAt: null }],
  columns: [
    {
      id: "column-done",
      boardId: "board-maintenance",
      name: "Done",
      isInitial: false,
      completionStatus: "complete"
    },
    {
      id: "column-pending",
      boardId: "board-maintenance",
      name: "Pending",
      isInitial: true,
      completionStatus: "pending"
    }
  ]
};

function request() {
  return new Request("https://query.example/v1/propose-command", {
    method: "POST",
    body: JSON.stringify({
      requestId: "proposal-1",
      text: "Create a maintenance ticket",
      locale: "en-US"
    })
  });
}

function handler(
  modelCaller: Parameters<typeof createCommandProposalHandler>[0]["modelCaller"]
) {
  return createCommandProposalHandler({
    pool: {} as never,
    configuration: {} as never,
    identityStore: {} as never,
    tokenVerifier: {} as never,
    sources,
    businessTimezone: "America/New_York",
    model: {
      version: "vertex.v1",
      project: "project-a",
      location: "us-east1",
      model: "model-2026-01-01",
      inputMicroUsdPerMillionTokens: 1,
      outputMicroUsdPerMillionTokens: 1
    },
    verifyWorkforce: vi.fn().mockResolvedValue(identity),
    authorizedSources: vi.fn().mockResolvedValue(sources.sources),
    loadCatalogs: vi
      .fn()
      .mockResolvedValue([{ source: sources.sources[0], catalog }]),
    modelCaller
  });
}

describe("command proposal endpoint", () => {
  it("binds the configured initial column instead of accepting a model-selected fallback", async () => {
    const response = await handler(
      vi.fn().mockResolvedValue({
        boardId: "board-maintenance",
        title: "Inspect motor",
        description: "Check vibration.",
        dueDate: "2026-09-14",
        clarification: null
      })
    )(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      kind: "ready",
      proposal: {
        action: "kanban.ticket.create",
        target: { sourceId: "kanban-a", resourceId: "board-maintenance" },
        payload: {
          initialColumnId: "column-pending",
          businessTimezone: "America/New_York",
          dueDate: "2026-09-14"
        }
      }
    });
    expect(body.proposal.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns explicit authorized choices for an ambiguous or unauthorized board", async () => {
    const response = await handler(
      vi.fn().mockResolvedValue({
        boardId: null,
        title: "Inspect motor",
        description: "",
        dueDate: "2026-09-14",
        clarification: "boardId"
      })
    )(request());
    expect(await response.json()).toEqual({
      kind: "clarification",
      field: "boardId",
      choices: [{ id: "board-maintenance", label: "Maintenance" }],
      message: "Choose an authorized board for this ticket."
    });
  });

  it("does not create a proposal with a model-supplied invalid calendar date", async () => {
    const response = await handler(
      vi.fn().mockResolvedValue({
        boardId: "board-maintenance",
        title: "Inspect motor",
        description: "",
        dueDate: "2026-02-31",
        clarification: null
      })
    )(request());
    expect(await response.json()).toMatchObject({
      kind: "clarification",
      field: "dueDate"
    });
  });
});
