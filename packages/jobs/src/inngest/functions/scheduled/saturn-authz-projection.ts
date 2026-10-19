import { redis } from "@carbon/kv";
import { getJobDatabaseClient } from "../../../db";
import { runAuthzProjection } from "../../../saturn-authz/projection";
import { inngest } from "../../client";

// Saturn fork, HQ plan 0006B (B7). Every minute the whole projection is
// re-applied (a no-op for rows that already match), so this run is also the
// reconcile: a person whose identity is linked after a grant is picked up
// within a minute. Only counts and the epoch enter Inngest's run history.
export const saturnAuthzProjectionFunction = inngest.createFunction(
  { id: "saturn-authz-projection", retries: 0, concurrency: 1 },
  { cron: "* * * * *" },
  async ({ step }) =>
    step.run("apply-projection", () =>
      runAuthzProjection(getJobDatabaseClient(), redis)
    )
);
