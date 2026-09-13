import type { OutboxBacklog } from "@carbon/portal/indexing/outbox.server";
import type { Telemetry } from "@carbon/portal/telemetry";

export type BacklogPrincipal = {
  companyId: string;
  callerId: string;
  sourceId?: string;
};

/**
 * Emit the outbox backlog ages after each delivery pass. The numbers feed the
 * index/ACL lag and queue-age alert policies; a failed observation is reported
 * as an indexing error and never interrupts delivery.
 */
export function createBacklogObserver(options: {
  telemetry: Pick<Telemetry, "record">;
  backlog: (principal: BacklogPrincipal) => Promise<OutboxBacklog>;
}) {
  return async function observeBacklog(
    principal: BacklogPrincipal
  ): Promise<void> {
    try {
      const backlog = await options.backlog(principal);
      options.telemetry.record("indexing", "success", {
        count: backlog.pending,
        lagSeconds: backlog.lagSeconds,
        queueSeconds: backlog.queueSeconds
      });
    } catch {
      options.telemetry.record("indexing", "error");
    }
  };
}
