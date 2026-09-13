import {
  acknowledgeOutbox,
  claimOutbox,
  confirmOutboxApplied,
  DELIVERY_EVENT_TYPES,
  type LeasedOutboxEvent
} from "@carbon/portal/indexing/outbox.server";
import { portalInngest } from "./inngest";

type PortalPool = Parameters<typeof claimOutbox>[0];
export function createOutboxDeliveryFunction(runtime: {
  pool: PortalPool;
  companies: ReadonlyArray<{ companyId: string; callerId: string }>;
  workerId: string;
  sourceId?: string;
  embeddingProfile: string;
  process?: (
    principal: { companyId: string; callerId: string },
    event: LeasedOutboxEvent,
    attempt: number
  ) => Promise<void>;
  /** Backlog telemetry after each company's pass; see `createBacklogObserver`. */
  observeBacklog?: (principal: {
    companyId: string;
    callerId: string;
    sourceId?: string;
  }) => Promise<void>;
}) {
  return portalInngest.createFunction(
    {
      id: "portal-outbox-delivery",
      retries: 3,
      concurrency: [{ limit: 1, key: "event.data.companyId" }]
    },
    [{ event: "portal/outbox.deliver" }, { cron: "*/1 * * * *" }],
    async ({ event, step, attempt }) => {
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
      let delivered = 0;
      for (const company of companies) {
        const principal = {
          companyId: company.companyId,
          callerId: company.callerId,
          ...(runtime.sourceId ? { sourceId: runtime.sourceId } : {})
        };
        // Indexing owns upserts only; invalidation kinds are leased by
        // createOutboxInvalidationFunction so the two never contend.
        const claimed = await step.run(`claim-${company.companyId}`, () =>
          claimOutbox(
            runtime.pool,
            principal,
            runtime.workerId,
            50,
            DELIVERY_EVENT_TYPES
          )
        );
        for (const entry of claimed) {
          await step.run(`apply-${entry.id}`, async () => {
            if (runtime.process)
              await runtime.process(principal, entry, attempt);
            await confirmOutboxApplied(
              runtime.pool,
              principal,
              entry,
              runtime.embeddingProfile
            );
          });
          await step.run(`acknowledge-${entry.id}`, () =>
            acknowledgeOutbox(runtime.pool, principal, runtime.workerId, [
              entry.id
            ])
          );
          delivered += 1;
        }
        const observeBacklog = runtime.observeBacklog;
        if (observeBacklog)
          await step.run(`observe-${company.companyId}`, () =>
            observeBacklog(principal)
          );
      }
      return { delivered };
    }
  );
}
