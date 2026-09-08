import { z } from "zod";
import { getJobDatabaseClient } from "../../../db";
import {
  dueProcurementSchedules,
  executeProcurementSchedule
} from "../../../procurement-schedule/execute";
import { inngest } from "../../client";

const eventData = z.object({ scheduleId: z.string().min(1).max(256) });

export const procurementScheduleExecuteFunction = inngest.createFunction(
  {
    id: "knowledge-procurement-schedule-execute",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.scheduleId" },
    idempotency: "event.data.scheduleId"
  },
  { event: "knowledge/procurement.schedule.execute" },
  async ({ event, step }) => {
    const { scheduleId } = eventData.parse(event.data);
    return await step.run("execute-scheduled-procurement-draft", () =>
      executeProcurementSchedule(getJobDatabaseClient(), scheduleId)
    );
  }
);

/** Durable backstop for a process crash between schedule persistence and event send. */
export const procurementScheduleSweepFunction = inngest.createFunction(
  { id: "knowledge-procurement-schedule-sweep", retries: 2 },
  { cron: "* * * * *" },
  async ({ step }) => {
    const ids = await step.run("list-due-procurement-schedules", () =>
      dueProcurementSchedules(getJobDatabaseClient())
    );
    if (ids.length === 0) return { dispatched: 0 };
    await step.sendEvent(
      "dispatch-due-procurement-schedules",
      ids.map((scheduleId) => ({
        name: "knowledge/procurement.schedule.execute" as const,
        data: { scheduleId }
      }))
    );
    return { dispatched: ids.length };
  }
);
