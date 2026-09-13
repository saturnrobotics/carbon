import {
  bumpSourceEpochs,
  INVALIDATION_EVENT_TYPES,
  planInvalidation,
  type SourceEpochBump
} from "@carbon/portal/cache/epochs.server";
import {
  type DatabasePrincipal,
  withPortalTransaction
} from "@carbon/portal/database.server";
import {
  acknowledgeOutbox,
  claimOutbox,
  confirmOutboxApplied,
  type LeasedOutboxEvent
} from "@carbon/portal/indexing/outbox.server";
import type { Pool } from "pg";
import { portalInngest } from "./inngest";

export type InvalidationPrincipal = DatabasePrincipal & { companyId: string };

/**
 * Applies one leased batch: the epochs move first in their own transaction,
 * so a cached answer stops being deliverable before any index work or
 * acknowledgement — a revocation never waits on a reindex. Events whose
 * source change must be visible before they are retired (document tombstones
 * and local ACL changes) are then confirmed exactly as delivery confirms them,
 * and only confirmed events are acknowledged. An event whose confirmation or
 * lease fails is deferred, never retried inside the batch: its lease expires
 * and the reconciliation cron re-leases it, and re-applying its bump only
 * invalidates again. That is why ordering, duplicates and partial failures
 * cannot produce a stale hit or wedge the other events in the batch.
 */
export async function applyOutboxInvalidation(
  pool: Pool,
  principal: InvalidationPrincipal,
  workerId: string,
  events: readonly LeasedOutboxEvent[]
): Promise<{
  plan: SourceEpochBump[];
  acknowledged: string[];
  deferred: string[];
}> {
  const plan = planInvalidation(events);
  if (plan.length)
    await withPortalTransaction(pool, principal, "write", (client) =>
      bumpSourceEpochs(client, principal.companyId, plan)
    );
  const acknowledged: string[] = [];
  const deferred: string[] = [];
  for (const event of events) {
    try {
      if (
        event.entityType === "document" &&
        (event.eventType === "delete" || event.eventType === "acl-change")
      )
        await confirmOutboxApplied(pool, principal, event);
      await acknowledgeOutbox(pool, principal, workerId, [event.id]);
      acknowledged.push(event.id);
    } catch {
      /* Content-free by design: the ids identify the retry, nothing else. */
      deferred.push(event.id);
    }
  }
  return { plan, acknowledged, deferred };
}

type PortalPool = Parameters<typeof claimOutbox>[0];

/**
 * Cache-invalidation consumer of the portal outbox. It leases only the
 * invalidation kinds (`INVALIDATION_EVENT_TYPES`), so indexing delivery and
 * this function never contend for an event, and it runs on the same triggers
 * as delivery: a producer's notification and a one-minute reconciliation cron
 * that recovers anything the notification missed.
 */
export function createOutboxInvalidationFunction(runtime: {
  pool: PortalPool;
  companies: ReadonlyArray<{ companyId: string; callerId: string }>;
  workerId: string;
  sourceId?: string;
}) {
  return portalInngest.createFunction(
    {
      id: "portal-outbox-invalidation",
      retries: 3,
      concurrency: [{ limit: 1, key: "event.data.companyId" }]
    },
    [{ event: "portal/outbox.deliver" }, { cron: "*/1 * * * *" }],
    async ({ event, step }) => {
      const requestedCompany =
        "data" in event &&
        event.data &&
        typeof (event.data as Record<string, unknown>).companyId === "string"
          ? ((event.data as Record<string, unknown>).companyId as string)
          : undefined;
      const companies = requestedCompany
        ? runtime.companies.filter(
            (entry) => entry.companyId === requestedCompany
          )
        : runtime.companies;
      let invalidated = 0;
      for (const company of companies) {
        const principal: InvalidationPrincipal = {
          companyId: company.companyId,
          callerId: company.callerId,
          ...(runtime.sourceId ? { sourceId: runtime.sourceId } : {})
        };
        // One batch per run: the cron reconciles the remainder, and a bounded
        // step output keeps document bodies and long lists out of durable state.
        const claimed = await step.run(`claim-${company.companyId}`, () =>
          claimOutbox(
            runtime.pool,
            principal,
            runtime.workerId,
            100,
            INVALIDATION_EVENT_TYPES
          )
        );
        if (!claimed.length) continue;
        const applied = await step.run(
          `invalidate-${company.companyId}`,
          async () =>
            applyOutboxInvalidation(
              runtime.pool,
              principal,
              runtime.workerId,
              claimed
            )
        );
        invalidated += applied.acknowledged.length;
      }
      return { invalidated };
    }
  );
}
