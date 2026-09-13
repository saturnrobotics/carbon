/**
 * Service-boundary proof of the action service against a real Kanban backend.
 *
 * It runs only when `PORTAL_KANBAN_BACKEND_DIR` names a checkout of the
 * Kanban `backend/` directory (with `uv` available). The backend is started on
 * a loopback port with a throwaway SQLite database in explicit test mode, so no
 * developer database or shared stack is touched, and the process is stopped
 * when the suite ends.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ticketCommandPayloadHash } from "@carbon/portal/commands/ticket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleTicketCommand } from "./server";

const backendDirectory = process.env.PORTAL_KANBAN_BACKEND_DIR;
const TEST_ACTOR_HEADER = "x-kanban-test-actor-id";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port"))
      );
    });
  });
}

async function waitForHealth(url: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Kanban backend did not become healthy at ${url}`);
}

describe.skipIf(!backendDirectory)(
  "portal-actions against a real Kanban backend",
  () => {
    let child: ChildProcess;
    let directory: string;
    let sourceUrl: string;
    let adminId: string;

    const identity = (actorId: string) => ({
      principal: {
        kind: "human" as const,
        actorId,
        companyId: "company:1",
        callerId: "portal-actions",
        sourceIdentity: {
          issuer: "https://cloud.google.com/iap",
          subject: `subject:${actorId}`
        },
        policyVersion: "policy:1",
        capabilities: ["kanban.ticket.create"]
      }
    });

    /** Stands in for the workforce edge: the real edge rebuilds these headers
     * per request; test mode selects the actor through its explicit header. */
    const dependencies = (
      actorId: string,
      fetchImpl: typeof fetch = fetch
    ) => ({
      sourceId: "kanban:example",
      sourceUrl,
      fetchImpl,
      verifyWorkforce: vi.fn().mockResolvedValue(identity(actorId)),
      forwardingHeaders: vi.fn().mockResolvedValue(
        new Headers({
          authorization: "Bearer synthetic-service",
          "x-portal-user-evidence": `synthetic-iap:${actorId}`,
          [TEST_ACTOR_HEADER]: actorId
        })
      )
    });

    const kanban = (actorId: string) => ({
      async post(path: string, body: unknown) {
        const response = await fetch(`${sourceUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [TEST_ACTOR_HEADER]: actorId
          },
          body: JSON.stringify(body)
        });
        if (!response.ok)
          throw new Error(`${path} failed with ${response.status}`);
        return response.json() as Promise<Record<string, unknown>>;
      },
      async get(path: string) {
        const response = await fetch(`${sourceUrl}${path}`, {
          headers: { [TEST_ACTOR_HEADER]: actorId }
        });
        if (!response.ok)
          throw new Error(`${path} failed with ${response.status}`);
        return response.json() as Promise<Record<string, unknown>>;
      }
    });

    async function boardWithInitialColumn() {
      const client = kanban(adminId);
      const board = (await client.post("/api/boards", {
        name: `Machine build ${crypto.randomUUID().slice(0, 8)}`
      })) as { id: string };
      const detail = (await client.get(`/api/boards/${board.id}`)) as {
        columns: Array<{ id: string; is_initial: boolean }>;
      };
      const initial = detail.columns.find((column) => column.is_initial);
      if (!initial) throw new Error("board has no configured initial column");
      return { board, initial };
    }

    function proposal(
      boardId: string,
      columnId: string,
      overrides: Partial<{ title: string; idempotencyKey: string }> = {}
    ) {
      const payload = {
        boardId,
        initialColumnId: columnId,
        title: overrides.title ?? "Surface grind the spindle housing",
        description: "Grind to drawing tolerance before assembly.",
        dueDate: "2026-09-14",
        businessTimezone: "America/New_York"
      };
      const idempotencyKey =
        overrides.idempotencyKey ?? `request-${crypto.randomUUID()}`;
      return {
        id: `command:${idempotencyKey}`,
        version: 1,
        action: "kanban.ticket.create",
        target: { sourceId: "kanban:example", resourceId: boardId },
        payload,
        payloadHash: ticketCommandPayloadHash(payload),
        idempotencyKey
      };
    }

    const submit = (body: unknown, actorId: string, fetchImpl?: typeof fetch) =>
      handleTicketCommand(
        new Request("https://actions.example.test/commands/tickets", {
          method: "POST",
          body: JSON.stringify(body)
        }),
        dependencies(actorId, fetchImpl)
      );

    beforeAll(async () => {
      if (!backendDirectory) return;
      directory = mkdtempSync(join(tmpdir(), "portal-actions-kanban-"));
      const port = await freePort();
      sourceUrl = `http://127.0.0.1:${port}`;
      const environment = {
        ...process.env,
        DATABASE_URL: `sqlite:///${join(directory, "kanban.db")}`,
        KANBAN_TEST_AUTH_DISABLED: "1",
        KANBAN_API_TOKEN: "",
        KANBAN_WORKFORCE_REQUIRED: "",
        SEED_DEMO_DATA: "1"
      };
      child = spawn(
        "uv",
        [
          "run",
          "uvicorn",
          "app.main:app",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--log-level",
          "warning"
        ],
        { cwd: backendDirectory, env: environment, stdio: "ignore" }
      );
      await waitForHealth(`${sourceUrl}/api/health`);
      adminId = execFileSync(
        "uv",
        [
          "run",
          "python",
          "-c",
          "from sqlalchemy import select\nfrom app.database import SessionLocal\nfrom app.models import User\nwith SessionLocal() as db:\n    print(db.scalar(select(User.id).where(User.role == 'admin').order_by(User.created_at, User.id)))"
        ],
        { cwd: backendDirectory, env: environment, encoding: "utf8" }
      ).trim();
      expect(adminId).toMatch(/^[0-9a-f-]{36}$/);
    }, 120_000);

    afterAll(() => {
      child?.kill("SIGTERM");
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it("creates one ticket in the configured initial column with the actor stamped", async () => {
      const { board, initial } = await boardWithInitialColumn();
      const command = proposal(board.id, initial.id);
      const created = await submit(command, adminId);
      expect(created.status).toBe(201);
      const result = (await created.json()) as {
        replayed: boolean;
        effective: Record<string, unknown>;
        ticketUrl: string;
      };
      expect(result.replayed).toBe(false);
      expect(result.effective).toMatchObject({
        boardId: board.id,
        columnId: initial.id,
        title: command.payload.title,
        dueDate: "2026-09-14"
      });
      expect(result.ticketUrl).toBe(`/tickets/${result.effective.ticketId}`);
      const activity = (await kanban(adminId).get(
        `/api/activity?entity_type=ticket&entity_id=${result.effective.ticketId}`
      )) as unknown as Array<{ action: string; actor_id: string }>;
      expect(activity.filter((event) => event.action === "created")).toEqual([
        expect.objectContaining({ actor_id: adminId })
      ]);

      const replay = await submit(command, adminId);
      expect(replay.status).toBe(200);
      expect(
        ((await replay.json()) as { effective: { ticketId: string } }).effective
          .ticketId
      ).toBe(result.effective.ticketId);
    });

    it("commits exactly one ticket for simultaneous retries of the same command", async () => {
      const { board, initial } = await boardWithInitialColumn();
      const command = proposal(board.id, initial.id);
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => submit(command, adminId))
      );
      const ids = await Promise.all(
        responses.map(async (response) => {
          expect([200, 201]).toContain(response.status);
          return (
            (await response.json()) as { effective: { ticketId: string } }
          ).effective.ticketId;
        })
      );
      expect(new Set(ids).size).toBe(1);
      const detail = (await kanban(adminId).get(`/api/boards/${board.id}`)) as {
        columns: Array<{ tickets: Array<{ id: string }> }>;
      };
      expect(detail.columns.flatMap((column) => column.tickets)).toHaveLength(
        1
      );
    });

    it("refuses a reused key whose payload changed", async () => {
      const { board, initial } = await boardWithInitialColumn();
      const command = proposal(board.id, initial.id);
      expect((await submit(command, adminId)).status).toBe(201);
      const changed = proposal(board.id, initial.id, {
        title: "A different title",
        idempotencyKey: command.idempotencyKey
      });
      expect((await submit(changed, adminId)).status).toBe(403);
      const detail = (await kanban(adminId).get(`/api/boards/${board.id}`)) as {
        columns: Array<{ tickets: Array<{ id: string }> }>;
      };
      expect(detail.columns.flatMap((column) => column.tickets)).toHaveLength(
        1
      );
    });

    it("refuses an actor without create access on the exact board", async () => {
      const { board, initial } = await boardWithInitialColumn();
      const outsider = (await kanban(adminId).post("/api/users", {
        name: "No Board Grant",
        email: `outsider-${crypto.randomUUID()}@example.test`
      })) as { id: string };
      const denied = await submit(proposal(board.id, initial.id), outsider.id);
      expect(denied.status).toBe(403);
      const detail = (await kanban(adminId).get(`/api/boards/${board.id}`)) as {
        columns: Array<{ tickets: Array<{ id: string }> }>;
      };
      expect(detail.columns.flatMap((column) => column.tickets)).toHaveLength(
        0
      );
    });

    it("recovers a committed command whose response was lost", async () => {
      const { board, initial } = await boardWithInitialColumn();
      const command = proposal(board.id, initial.id);
      const lossy: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "POST") throw new TypeError("socket hang up");
        return response;
      };
      const recovered = await submit(command, adminId, lossy);
      expect(recovered.status).toBe(200);
      const result = (await recovered.json()) as {
        replayed: boolean;
        effective: { ticketId: string; columnId: string };
      };
      expect(result.replayed).toBe(true);
      expect(result.effective.columnId).toBe(initial.id);
      const detail = (await kanban(adminId).get(`/api/boards/${board.id}`)) as {
        columns: Array<{ tickets: Array<{ id: string }> }>;
      };
      expect(detail.columns.flatMap((column) => column.tickets)).toEqual([
        expect.objectContaining({ id: result.effective.ticketId })
      ]);
    });
  }
);
