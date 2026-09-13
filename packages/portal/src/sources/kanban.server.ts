import { now } from "@internationalized/date";
import { z } from "zod";
import {
  type ChangePage,
  changePageSchema,
  documentReferencePageSchema,
  entityPageSchema,
  factQuerySchema,
  type SourceOutcome,
  sourceEntitySchema,
  sourceSearchSchema,
  ticketSchema
} from "./contract";
import {
  createMachineSourceTransport,
  createSourceTransport,
  type MachineSourceRequestContext,
  type SourceConnection,
  type SourceRequestContext,
  SourceTransportError
} from "./http.server";
import { factValidUntil, outcomeFromError } from "./outcome";

/**
 * Kanban as a portal source. Board membership is the Kanban API's own
 * decision on every call: a ticket on a board the caller cannot view answers
 * 403, which becomes `insufficient-permission` — distinct from `not-found`, and
 * never a name or a count of what was hidden.
 */

type SourceEntity = z.infer<typeof sourceEntitySchema>;
type SourceEntityPage = z.infer<typeof entityPageSchema>;
const id = z.string().min(1).max(256);
const catalogSchema = z
  .object({
    sourceRevision: z.string().max(512),
    observedAt: z.string().max(40),
    partial: z.boolean(),
    boards: z
      .array(
        z.object({
          id,
          name: z.string().max(500),
          archivedAt: z.string().max(40).nullable()
        })
      )
      .max(100),
    columns: z
      .array(
        z.object({
          id,
          boardId: id,
          name: z.string().max(500),
          isInitial: z.boolean(),
          completionStatus: z.string().max(100)
        })
      )
      .max(500)
  })
  .strict();
const ticketEnvelopeSchema = z
  .object({
    sourceRevision: z.string().max(512),
    observedAt: z.string().max(40),
    ticket: ticketSchema
  })
  .strict();
const searchEnvelopeSchema = z
  .object({
    sourceRevision: z.string().max(512),
    items: z.array(ticketSchema).max(100),
    nextCursor: id.nullable(),
    observedAt: z.string().max(40)
  })
  .strict();
const kanbanChangeSchema = z
  .object({
    id,
    workspaceId: id,
    source: z.literal("kanban"),
    entityType: z.string().min(1).max(100),
    entityId: id,
    entityVersion: z.string().min(1).max(512),
    eventKind: z.string().min(1).max(100),
    createdAt: z.string().max(64)
  })
  .strict();
const kanbanChangesSchema = z
  .object({
    items: z.array(kanbanChangeSchema).max(100),
    nextCursor: id.nullable()
  })
  .strict();

function ticketPath(ticket: { id: string; boardId: string }): string {
  return `/boards/${encodeURIComponent(ticket.boardId)}?ticket=${encodeURIComponent(ticket.id)}`;
}

export function projectKanbanTicket(
  origin: string,
  ticket: z.infer<typeof ticketSchema>,
  sourceRevision: string
): SourceEntity {
  return sourceEntitySchema.parse({
    id: ticket.id,
    type: "ticket",
    title: ticket.title || ticket.id,
    ...(ticket.description
      ? { description: ticket.description.slice(0, 8000) }
      : {}),
    revision: `${sourceRevision}#${ticket.version}`,
    fields: {
      boardId: ticket.boardId,
      columnId: ticket.columnId,
      dueDate: ticket.dueDate,
      version: ticket.version,
      updatedAt: ticket.updatedAt,
      archivedAt: ticket.archivedAt,
      link: new URL(ticketPath(ticket), origin).toString()
    }
  });
}

function observed(value: string): string {
  // Kanban serialises timestamps without an offset when they are UTC-naive;
  // the contract requires an offset, so a bare value is read as UTC.
  return /[Zz]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
}

/** Mapped by Kanban's own event kinds; unknown kinds are treated as upserts. */
export function kanbanEventType(
  kind: string
): "upsert" | "delete" | "acl-change" {
  if (kind === "delete" || kind === "archive" || kind === "archived")
    return "delete";
  if (kind === "acl-change" || kind === "board-change" || kind === "move")
    return "acl-change";
  return "upsert";
}

export function createKanbanSourceAdapter(
  connection: SourceConnection,
  context: SourceRequestContext
) {
  const transport = createSourceTransport(connection, context);
  const origin = connection.origin;
  const principal = context.identity.principal;

  async function readTicket(ticketId: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(ticketId))
      throw Error("Invalid entity identifier");
    return ticketEnvelopeSchema.parse(
      await transport.get(`/api/portal/tickets/${ticketId}`)
    );
  }

  return {
    kind: "kanban" as const,
    async searchEntities(
      input: unknown
    ): Promise<{ outcome: SourceOutcome; page: SourceEntityPage | null }> {
      const search = sourceSearchSchema.parse(input);
      try {
        const result = searchEnvelopeSchema.parse(
          await transport.post("/api/portal/tickets/search", {
            query: search.query,
            limit: search.limit,
            ...(search.cursor ? { cursor: search.cursor } : {})
          })
        );
        const page = entityPageSchema.parse({
          items: result.items
            .slice(0, search.limit)
            .map((ticket) =>
              projectKanbanTicket(origin, ticket, result.sourceRevision)
            ),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          observedAt: observed(result.observedAt),
          sourceRevision: result.sourceRevision,
          status: result.nextCursor ? "partial" : "complete",
          ...(result.nextCursor
            ? { incompleteReason: "more-results-behind-cursor" }
            : {})
        });
        return { outcome: { kind: "ok" }, page };
      } catch (error) {
        return { outcome: outcomeFromError(error), page: null };
      }
    },
    async getEntity(ticketId: string): Promise<{
      outcome: SourceOutcome;
      entity: SourceEntity | null;
      observedAt: string;
    }> {
      try {
        const result = await readTicket(ticketId);
        if (result.ticket.id !== ticketId)
          throw Error("Source returned a different entity");
        return {
          outcome: { kind: "ok" },
          entity: projectKanbanTicket(
            origin,
            result.ticket,
            result.sourceRevision
          ),
          observedAt: observed(result.observedAt)
        };
      } catch (error) {
        if (error instanceof SourceTransportError && error.status === 404)
          return {
            outcome: { kind: "not-found" },
            entity: null,
            observedAt: now("UTC").toAbsoluteString()
          };
        return {
          outcome: outcomeFromError(error),
          entity: null,
          observedAt: now("UTC").toAbsoluteString()
        };
      }
    },
    async queryFacts(input: unknown) {
      const query = factQuerySchema.parse(input);
      if (query.fact !== "status" && query.fact !== "revision")
        return {
          outcome: {
            kind: "unavailable",
            reason: "unsupported"
          } as SourceOutcome,
          facts: null
        };
      try {
        const [ticket, catalog] = await Promise.all([
          readTicket(query.entityId),
          transport
            .get("/api/portal/catalog")
            .then((raw) => catalogSchema.parse(raw))
        ]);
        const column = catalog.columns.find(
          (entry) => entry.id === ticket.ticket.columnId
        );
        const board = catalog.boards.find(
          (entry) => entry.id === ticket.ticket.boardId
        );
        const observedAt = observed(ticket.observedAt);
        return {
          outcome: { kind: "ok" } as SourceOutcome,
          facts: {
            entityId: ticket.ticket.id,
            sourceRevision: ticket.sourceRevision,
            observedAt,
            validUntil: factValidUntil(observedAt),
            facts:
              query.fact === "revision"
                ? [{ label: "Version", value: `${ticket.ticket.version}` }]
                : [
                    { label: "Board", value: board?.name ?? "" },
                    { label: "Column", value: column?.name ?? "" },
                    {
                      label: "Completion",
                      value: column?.completionStatus ?? ""
                    },
                    { label: "Due", value: ticket.ticket.dueDate ?? "" },
                    {
                      label: "Archived",
                      value: ticket.ticket.archivedAt ? "yes" : "no"
                    }
                  ]
          }
        };
      } catch (error) {
        if (error instanceof SourceTransportError && error.status === 404)
          return {
            outcome: { kind: "not-found" } as SourceOutcome,
            facts: null
          };
        return { outcome: outcomeFromError(error), facts: null };
      }
    },
    async getDocumentReferences(entityId: string) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(entityId))
        throw Error("Invalid entity identifier");
      // Kanban holds no documents; an empty complete page is authoritative.
      return {
        outcome: { kind: "ok" } as SourceOutcome,
        page: documentReferencePageSchema.parse({
          items: [],
          observedAt: now("UTC").toAbsoluteString(),
          sourceRevision: "kanban:no-documents",
          status: "complete"
        })
      };
    },
    /**
     * Board ids resolve through one catalog read (the caller's whole board
     * scope); ticket ids need one bounded read each because Kanban exposes no
     * batched ticket authorization. Never more than 40 ids, 8 in flight.
     */
    async checkAccess(input: { kind: "board" | "ticket"; ids: string[] }) {
      const ids = [...new Set(input.ids)];
      if (
        ids.length < 1 ||
        ids.length > 40 ||
        ids.some((value) => !/^[A-Za-z0-9_-]{1,256}$/.test(value))
      )
        throw Error("Invalid access projection");
      let outcome: SourceOutcome = { kind: "ok" };
      const allowed = new Set<string>();
      let observedAt = now("UTC").toAbsoluteString();
      if (input.kind === "board") {
        try {
          const catalog = catalogSchema.parse(
            await transport.get("/api/portal/catalog")
          );
          observedAt = observed(catalog.observedAt);
          for (const board of catalog.boards)
            if (ids.includes(board.id)) allowed.add(board.id);
          if (catalog.partial)
            outcome = { kind: "unavailable", reason: "source-error" };
        } catch (error) {
          outcome = outcomeFromError(error);
        }
      } else {
        let index = 0;
        await Promise.all(
          Array.from({ length: Math.min(8, ids.length) }, async () => {
            while (index < ids.length) {
              const ticketId = ids[index++] as string;
              try {
                const result = await readTicket(ticketId);
                if (result.ticket.id === ticketId) allowed.add(ticketId);
              } catch (error) {
                const failure = outcomeFromError(error);
                if (
                  failure.kind !== "insufficient-permission" &&
                  !(
                    error instanceof SourceTransportError &&
                    error.status === 404
                  )
                )
                  outcome = failure;
              }
            }
          })
        );
      }
      return {
        outcome,
        result: {
          allowedIds: input.ids.filter((value) => allowed.has(value)),
          policyVersion: principal.policyVersion,
          validUntil: factValidUntil(observedAt)
        }
      };
    }
  };
}

export type KanbanSourceAdapter = ReturnType<typeof createKanbanSourceAdapter>;

/** Kanban's machine feed is cursor-based and acknowledgement-free. */
export function createKanbanChangeFeed(
  connection: SourceConnection,
  context: MachineSourceRequestContext
) {
  const transport = createMachineSourceTransport(connection, context);
  return {
    async getChanges(input: {
      cursor?: string;
      limit: number;
    }): Promise<ChangePage> {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
      if (input.cursor && !/^[A-Za-z0-9_.-]{1,512}$/.test(input.cursor))
        throw Error("Invalid changes cursor");
      const query = new URLSearchParams({
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: `${limit}`
      });
      const result = kanbanChangesSchema.parse(
        await transport.get(`/api/portal/changes?${query.toString()}`)
      );
      const observedAt = now("UTC").toAbsoluteString();
      return changePageSchema.parse({
        items: result.items.map((change) => ({
          id: change.id,
          entityType: change.entityType,
          entityId: change.entityId,
          sourceVersion: change.entityVersion,
          eventType: kanbanEventType(change.eventKind),
          observedAt: observed(change.createdAt)
        })),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        observedAt,
        sourceRevision:
          result.items.at(-1)?.id ?? input.cursor ?? "kanban:start",
        status: result.nextCursor ? "partial" : "complete",
        ...(result.nextCursor
          ? { incompleteReason: "more-changes-behind-cursor" }
          : {})
      });
    }
  };
}
