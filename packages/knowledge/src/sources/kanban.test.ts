import { describe, expect, it } from "vitest";
import {
  createKanbanChangeFeed,
  createKanbanSourceAdapter,
  kanbanEventType
} from "./kanban.server";

const connection = {
  origin: "https://kanban.example",
  audience: "kanban-audience"
};
const identity = {
  principal: {
    kind: "human" as const,
    actorId: "alice",
    companyId: "company-a",
    callerId: "query",
    sourceIdentity: { issuer: "iap", subject: "a" },
    policyVersion: "identity-1:permission-1",
    capabilities: ["knowledge.read"]
  },
  companyGroupId: "group-a",
  allowedOperations: [],
  accessLevels: []
};
const ticket = {
  id: "ticket-1",
  boardId: "board-maintenance",
  columnId: "column-doing",
  title: "Replace spindle bearing",
  description: "Bearing 6205 on cell 3",
  dueDate: "2026-09-12",
  version: 4,
  updatedAt: "2026-09-01T10:00:00",
  archivedAt: null
};
const catalog = {
  sourceRevision: "kanban:ws:12",
  observedAt: "2026-09-01T10:00:00",
  partial: false,
  boards: [{ id: "board-maintenance", name: "Maintenance", archivedAt: null }],
  columns: [
    {
      id: "column-doing",
      boardId: "board-maintenance",
      name: "Doing",
      isInitial: false,
      completionStatus: "in_progress"
    }
  ]
};

function adapter(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>
) {
  return createKanbanSourceAdapter(connection, {
    request: new Request("https://query.example"),
    identity,
    headers: async () => new Headers(),
    fetch: async (url, init) => handler(url as URL, init ?? {})
  });
}

describe("Kanban read adapter", () => {
  it("projects a ticket page with a cursor, a source revision and a board deep link", async () => {
    const source = adapter((url, init) => {
      expect(url.pathname).toBe("/api/knowledge/tickets/search");
      expect(JSON.parse(String(init.body))).toEqual({
        query: "bearing",
        limit: 5,
        cursor: "ticket-0"
      });
      return Response.json({
        sourceRevision: "kanban:ws:12",
        observedAt: "2026-09-01T10:00:00",
        items: [ticket],
        nextCursor: "ticket-1"
      });
    });
    const { outcome, page } = await source.searchEntities({
      query: "bearing",
      limit: 5,
      cursor: "ticket-0"
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(page).toMatchObject({
      status: "partial",
      nextCursor: "ticket-1",
      sourceRevision: "kanban:ws:12",
      observedAt: "2026-09-01T10:00:00Z"
    });
    expect(page?.items[0]).toMatchObject({
      type: "ticket",
      revision: "kanban:ws:12#4",
      fields: {
        boardId: "board-maintenance",
        link: "https://kanban.example/boards/board-maintenance?ticket=ticket-1"
      }
    });
  });
  it("separates an unauthorized board from a missing ticket without naming either", async () => {
    const source = adapter((url) => {
      if (url.pathname.endsWith("/hidden"))
        return new Response("forbidden", { status: 403 });
      if (url.pathname.endsWith("/gone"))
        return new Response("missing", { status: 404 });
      return Response.json({
        sourceRevision: "kanban:ws:12",
        observedAt: "2026-09-01T10:00:00",
        ticket
      });
    });
    const hidden = await source.getEntity("hidden");
    expect(hidden).toMatchObject({
      outcome: { kind: "insufficient-permission" },
      entity: null
    });
    expect(JSON.stringify(hidden)).not.toContain("forbidden");
    expect((await source.getEntity("gone")).outcome).toEqual({
      kind: "not-found"
    });
    expect((await source.getEntity("ticket-1")).entity?.title).toBe(
      "Replace spindle bearing"
    );
  });
  it("answers status facts from the ticket and the caller's own catalog", async () => {
    const source = adapter((url) =>
      Response.json(
        url.pathname === "/api/knowledge/catalog"
          ? catalog
          : {
              sourceRevision: "kanban:ws:12",
              observedAt: "2026-09-01T10:00:00",
              ticket
            }
      )
    );
    const { outcome, facts } = await source.queryFacts({
      entityId: "ticket-1",
      fact: "status"
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(facts).toMatchObject({
      sourceRevision: "kanban:ws:12",
      validUntil: "2026-09-01T10:00:15.000Z",
      facts: [
        { label: "Board", value: "Maintenance" },
        { label: "Column", value: "Doing" },
        { label: "Completion", value: "in_progress" },
        { label: "Due", value: "2026-09-12" },
        { label: "Archived", value: "no" }
      ]
    });
    expect(
      (await source.queryFacts({ entityId: "ticket-1", fact: "availability" }))
        .outcome
    ).toEqual({ kind: "unavailable", reason: "unsupported" });
  });
  it("resolves board access through one catalog read and never widens the requested set", async () => {
    let calls = 0;
    const source = adapter(() => {
      calls += 1;
      return Response.json({
        ...catalog,
        boards: [
          ...catalog.boards,
          { id: "board-secret", name: "Secret", archivedAt: null }
        ]
      });
    });
    const access = await source.checkAccess({
      kind: "board",
      ids: ["board-maintenance", "board-unknown"]
    });
    expect(calls).toBe(1);
    expect(access.result.allowedIds).toEqual(["board-maintenance"]);
    expect(JSON.stringify(access)).not.toContain("board-secret");
  });
  it("holds an empty document page as authoritative for a source with no documents", async () => {
    const source = adapter(() => Response.json({}));
    const { outcome, page } = await source.getDocumentReferences("ticket-1");
    expect(outcome).toEqual({ kind: "ok" });
    expect(page).toMatchObject({ items: [], status: "complete" });
  });
});

describe("Kanban change feed", () => {
  it("reads the machine cursor feed with the service credential and maps event kinds", async () => {
    let seen: { url: URL; init: RequestInit } | undefined;
    const feed = createKanbanChangeFeed(connection, {
      companyId: "company-a",
      authorizationHeader: async () => "Bearer fresh-service-token",
      fetch: async (url, init) => {
        seen = { url: url as URL, init: init ?? {} };
        return Response.json({
          items: [
            {
              id: "evt-1",
              workspaceId: "ws",
              source: "kanban",
              entityType: "ticket",
              entityId: "ticket-1",
              entityVersion: "4",
              eventKind: "archived",
              createdAt: "2026-09-01T10:00:00"
            }
          ],
          nextCursor: "evt-1"
        });
      }
    });
    const page = await feed.getChanges({ cursor: "evt-0", limit: 1000 });
    expect(seen?.url.pathname).toBe("/api/knowledge/changes");
    expect(seen?.url.search).toBe("?cursor=evt-0&limit=100");
    expect(new Headers(seen?.init.headers).get("authorization")).toBe(
      "Bearer fresh-service-token"
    );
    expect(page).toMatchObject({
      status: "partial",
      nextCursor: "evt-1",
      items: [
        {
          id: "evt-1",
          entityType: "ticket",
          entityId: "ticket-1",
          sourceVersion: "4",
          eventType: "delete",
          observedAt: "2026-09-01T10:00:00Z"
        }
      ]
    });
    expect(kanbanEventType("update")).toBe("upsert");
    expect(kanbanEventType("board-change")).toBe("acl-change");
    await expect(
      feed.getChanges({ cursor: "../admin", limit: 1 })
    ).rejects.toThrow("cursor");
  });
});
