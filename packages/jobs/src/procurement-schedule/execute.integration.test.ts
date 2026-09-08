import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dueProcurementSchedules, executeProcurementSchedule } from "./execute";

const databaseUrl = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const enabled = (() => {
  if (process.env.KNOWLEDGE_TEST_DATABASE_DISPOSABLE !== "1" || !databaseUrl)
    return false;
  const url = new URL(databaseUrl);
  return (
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.port !== "5432" &&
    url.pathname === "/knowledge_test" &&
    url.username === "knowledge_test_migrator"
  );
})();

const companyId = "task21-schedule-company";
const groupId = "task21-schedule-group";
const actorId = "task21-schedule-actor";
const scheduleId = "task21-schedule";
const receiptId = "task21-source-receipt";
const purchaseOrderId = "task21-draft-po";
const payloadHash = "a".repeat(64);
const payload = {
  idempotencyKey: "task21-schedule-command",
  payloadHash,
  supplierId: "supplier-authoritative",
  receivingLocationId: "location-authoritative",
  proposedOrderByDate: "2026-09-09",
  executeAt: "2026-09-08T12:00:00.000Z",
  lines: []
};

const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl })
  : undefined;
const db = pool
  ? new Kysely({ dialect: new PostgresDialect({ pool }) })
  : undefined;

async function seed(permission: Record<string, string[]>) {
  await sql`
    INSERT INTO public.company (id, active, "companyGroupId")
    VALUES (${companyId}, true, ${groupId})
    ON CONFLICT (id) DO UPDATE SET active = true, "companyGroupId" = EXCLUDED."companyGroupId"
  `.execute(db!);
  await sql`
    INSERT INTO public."user" (id, active) VALUES (${actorId}, true)
    ON CONFLICT (id) DO UPDATE SET active = true
  `.execute(db!);
  await sql`
    INSERT INTO public.employee (id, "companyId", active) VALUES (${actorId}, ${companyId}, true)
    ON CONFLICT (id, "companyId") DO UPDATE SET active = true
  `.execute(db!);
  await sql`
    INSERT INTO public."userToCompany" ("userId", "companyId", role)
    VALUES (${actorId}, ${companyId}, 'employee')
    ON CONFLICT ("userId", "companyId") DO UPDATE SET role = 'employee'
  `.execute(db!);
  await sql`
    INSERT INTO public."userPermission" (id, permissions) VALUES (${actorId}, ${JSON.stringify(permission)}::jsonb)
    ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions
  `.execute(db!);
}

async function schedule(executeAt: "past" | "future") {
  await sql`
    INSERT INTO public."knowledgeProcurementSchedule" (
      id, "companyId", "companyGroupId", "actorId", action, version, payload,
      "payloadHash", "idempotencyKey", "executeAt", "createdBy"
    ) VALUES (
      ${scheduleId}, ${companyId}, ${groupId}, ${actorId}, 'carbon.procurement.draft', 1,
      ${JSON.stringify(payload)}::jsonb, ${payloadHash}, 'task21-schedule-command',
      clock_timestamp() + ${executeAt === "past" ? sql`interval '-1 minute'` : sql`interval '1 hour'`},
      ${actorId}
    )
  `.execute(db!);
}

async function status() {
  const result = await sql<{ status: string; purchaseOrderId: string | null }>`
    SELECT status, "purchaseOrderId" FROM public."knowledgeProcurementSchedule" WHERE id = ${scheduleId}
  `.execute(db!);
  const row = result.rows[0];
  if (!row) throw new Error("Expected the scheduled procurement row");
  return row;
}

describe.skipIf(!enabled)(
  "scheduled procurement against disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      await sql`DELETE FROM public."knowledgeProcurementSchedule" WHERE id = ${scheduleId}`.execute(
        db!
      );
      await sql`DELETE FROM public."knowledgeCommandReceipt" WHERE id = ${receiptId}`.execute(
        db!
      );
      await sql`DELETE FROM public."purchaseOrder" WHERE id = ${purchaseOrderId}`.execute(
        db!
      );
    });

    afterAll(async () => {
      if (db) {
        await sql`DELETE FROM public."knowledgeProcurementSchedule" WHERE id = ${scheduleId}`.execute(
          db
        );
        await sql`DELETE FROM public."knowledgeCommandReceipt" WHERE id = ${receiptId}`.execute(
          db
        );
        await sql`DELETE FROM public."purchaseOrder" WHERE id = ${purchaseOrderId}`.execute(
          db
        );
        await sql`DELETE FROM public.employee WHERE id = ${actorId} AND "companyId" = ${companyId}`.execute(
          db
        );
        await sql`DELETE FROM public."userToCompany" WHERE "userId" = ${actorId} AND "companyId" = ${companyId}`.execute(
          db
        );
        await sql`DELETE FROM public."userPermission" WHERE id = ${actorId}`.execute(
          db
        );
        await sql`DELETE FROM public."user" WHERE id = ${actorId}`.execute(db);
        await sql`DELETE FROM public.company WHERE id = ${companyId}`.execute(
          db
        );
      }
      await pool?.end();
    });

    it("rechecks a revoked actor before calling the canonical command", async () => {
      await seed({});
      await schedule("past");
      const dispatch = vi.fn();

      await expect(
        executeProcurementSchedule(db! as never, scheduleId, dispatch)
      ).resolves.toEqual({ state: "revoked" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await status()).toMatchObject({
        status: "cancelled",
        purchaseOrderId: null
      });
      const orders = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM public."purchaseOrder" WHERE id = ${purchaseOrderId}`.execute(
        db!
      );
      expect(orders.rows[0]?.count).toBe("0");
    });

    it("waits for due time and converges sweep/event retries to one PO and receipt", async () => {
      await seed({ purchasing_create: [companyId] });
      await schedule("future");
      const dispatch = vi.fn(async (_context, command) => {
        expect(command).not.toHaveProperty("executeAt");
        expect(command).not.toHaveProperty("actorId");
        expect(command).not.toHaveProperty("companyId");
        await sql`INSERT INTO public."purchaseOrder" (id) VALUES (${purchaseOrderId}) ON CONFLICT DO NOTHING`.execute(
          db!
        );
        await sql`
        INSERT INTO public."knowledgeCommandReceipt" (
          id, "companyId", "actorId", action, "idempotencyKey", "payloadHash", "purchaseOrderId"
        ) VALUES (
          ${receiptId}, ${companyId}, ${actorId}, 'carbon.procurement.draft',
          'task21-schedule-command', ${payloadHash}, ${purchaseOrderId}
        ) ON CONFLICT ("companyId", "actorId", action, "idempotencyKey") DO NOTHING
      `.execute(db!);
        return { success: true, data: { purchaseOrderId } };
      });

      await expect(
        executeProcurementSchedule(db! as never, scheduleId, dispatch)
      ).resolves.toEqual({ state: "not_due_or_claimed" });
      expect(dispatch).not.toHaveBeenCalled();
      await expect(
        dueProcurementSchedules(db! as never)
      ).resolves.not.toContain(scheduleId);
      await sql`UPDATE public."knowledgeProcurementSchedule" SET "executeAt" = clock_timestamp() - interval '1 minute' WHERE id = ${scheduleId}`.execute(
        db!
      );
      await expect(dueProcurementSchedules(db! as never)).resolves.toContain(
        scheduleId
      );

      const outcomes = await Promise.all([
        executeProcurementSchedule(db! as never, scheduleId, dispatch),
        executeProcurementSchedule(db! as never, scheduleId, dispatch)
      ]);
      expect(outcomes).toContainEqual({ state: "succeeded", purchaseOrderId });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(await status()).toMatchObject({
        status: "succeeded",
        purchaseOrderId
      });
      const receipts = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM public."knowledgeCommandReceipt" WHERE "companyId" = ${companyId} AND "actorId" = ${actorId}`.execute(
        db!
      );
      expect(receipts.rows[0]?.count).toBe("1");
    });
  }
);
