import type { DatabasePrincipal } from "@carbon/portal/database.server";
import { createServiceAuthorizationHeader } from "@carbon/portal/identity.server";
import {
  CARBON_PORTAL_ENTITY_TYPES,
  type CarbonChangeFeed,
  createCarbonChangeFeed,
  getCarbonSweepState,
  nextSweepState,
  persistCarbonChangePage,
  planCarbonChanges,
  reconcileCarbonRange
} from "@carbon/portal/sources/carbon.server";
import type { SourceChange } from "@carbon/portal/sources/contract";
import type { Pool } from "pg";
import { z } from "zod";
import { portalInngest } from "./inngest";

/**
 * Carbon → portal change consumer (the worker half of plan Task 15).
 *
 * `portal-carbon-changes` pulls leased events from Carbon's source-changes
 * route, projects them into `portal.entity` (and invalidation events into
 * the portal outbox), and acknowledges only what was committed. Every step
 * is idempotent and order-independent: a redelivered or reordered event
 * re-applies Carbon's latest observation, and an older observation can never
 * overwrite a newer one.
 *
 * `portal-carbon-reconcile` is the periodic sweep for what the trigger
 * skips (dataset applies and restores run with the trigger silenced). It walks
 * each entity type in bounded keyset pages, merge-joining Carbon's current
 * versions against the index: matching versions write nothing, differing ones
 * are re-projected, and rows Carbon no longer lists are tombstoned.
 */

export const carbonSourceConfigurationSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(256),
    origin: z.string().url().max(2048),
    audience: z.string().trim().min(1).max(2048)
  })
  .strict();
export type CarbonSourceConfiguration = z.infer<
  typeof carbonSourceConfigurationSchema
>;

export function readCarbonSourceConfiguration(
  environment: NodeJS.ProcessEnv
): CarbonSourceConfiguration | null {
  const raw = environment.PORTAL_CARBON_SOURCE_JSON?.trim();
  if (!raw) return null;
  return carbonSourceConfigurationSchema.parse(JSON.parse(raw));
}

export type CarbonChangeRuntime = {
  pool: Pool;
  companies: ReadonlyArray<{ companyId: string; callerId: string }>;
  workerId: string;
  source: CarbonSourceConfiguration;
  automationUserId: string;
  /** Mints the Carbon receiver credential; defaults to a Google ID token. */
  authorizationHeader?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Test seam; production builds the feed from the configuration. */
  feed?: (companyId: string) => CarbonChangeFeed;
};

export const CARBON_CHANGE_PAGE_LIMIT = 100;
export const CARBON_CHANGE_PAGES_PER_RUN = 5;
export const CARBON_SWEEP_PAGE_LIMIT = 100;

function principalFor(
  runtime: CarbonChangeRuntime,
  company: { companyId: string; callerId: string }
): DatabasePrincipal {
  return {
    companyId: company.companyId,
    callerId: company.callerId,
    sourceId: runtime.source.sourceId
  };
}

export function carbonFeedFor(
  runtime: CarbonChangeRuntime,
  companyId: string
): CarbonChangeFeed {
  if (runtime.feed) return runtime.feed(companyId);
  return createCarbonChangeFeed(
    { origin: runtime.source.origin, audience: runtime.source.audience },
    {
      companyId,
      authorizationHeader:
        runtime.authorizationHeader ??
        (() => createServiceAuthorizationHeader(runtime.source.audience)),
      fetch: runtime.fetchImpl
    },
    { sourceId: runtime.source.sourceId, workerId: runtime.workerId }
  );
}

/**
 * One page: claim, project, commit, acknowledge — in that order. An
 * unavailable feed acknowledges nothing; a failed commit acknowledges nothing;
 * a lost lease is reported in `unacknowledged` and simply redelivers.
 */
export async function pullCarbonChanges(
  runtime: CarbonChangeRuntime,
  company: { companyId: string; callerId: string }
): Promise<{
  claimed: number;
  upserted: number;
  tombstoned: number;
  invalidations: number;
  acknowledged: number;
  unacknowledged: string[];
  status: "complete" | "partial" | "unavailable";
}> {
  const feed = carbonFeedFor(runtime, company.companyId);
  const page = await feed.getChanges({ limit: CARBON_CHANGE_PAGE_LIMIT });
  if (page.status === "unavailable" || !page.items.length)
    return {
      claimed: page.items.length,
      upserted: 0,
      tombstoned: 0,
      invalidations: 0,
      acknowledged: 0,
      unacknowledged: page.items.map((change) => change.id),
      status: page.status
    };
  const written = await persistCarbonChangePage(
    runtime.pool,
    principalFor(runtime, company),
    {
      sourceId: runtime.source.sourceId,
      automationUserId: runtime.automationUserId,
      plan: planCarbonChanges(page.items)
    }
  );
  const ids = page.items.map((change) => change.id);
  const acknowledged = new Set(await feed.acknowledge(ids));
  return {
    claimed: ids.length,
    ...written,
    acknowledged: acknowledged.size,
    unacknowledged: ids.filter((id) => !acknowledged.has(id)),
    status: page.status
  };
}

/** One sweep page for the company's current entity type. */
export async function sweepCarbonEntities(
  runtime: CarbonChangeRuntime,
  company: { companyId: string; callerId: string }
): Promise<{
  entityType: string;
  listed: number;
  refreshed: number;
  tombstoned: number;
  done: boolean;
  status: "complete" | "partial" | "unavailable";
}> {
  const principal = principalFor(runtime, company);
  const feed = carbonFeedFor(runtime, company.companyId);
  const state = await getCarbonSweepState(
    runtime.pool,
    principal,
    runtime.source.sourceId
  );
  const versions = await feed.listVersions({
    entityType: state.entityType,
    ...(state.afterId ? { cursor: state.afterId } : {}),
    limit: CARBON_SWEEP_PAGE_LIMIT
  });
  if (versions.status === "unavailable")
    return {
      entityType: state.entityType,
      listed: 0,
      refreshed: 0,
      tombstoned: 0,
      done: false,
      status: "unavailable"
    };
  const lastId = versions.items.at(-1)?.entityId ?? null;
  const done = !versions.nextCursor;
  const next = nextSweepState(state, { lastId, done });
  const portalEntityType = CARBON_PORTAL_ENTITY_TYPES[state.entityType];
  const { stale, tombstoned } = await reconcileCarbonRange(
    runtime.pool,
    principal,
    {
      sourceId: runtime.source.sourceId,
      automationUserId: runtime.automationUserId,
      entityType: state.entityType,
      portalEntityType,
      afterId: state.afterId,
      lastId: done ? null : lastId,
      versions: versions.items,
      observedAt: versions.observedAt,
      expected: state,
      next
    }
  );
  let refreshed = 0;
  if (stale.length) {
    const projections = await feed.getProjections({
      entityType: state.entityType,
      entityIds: stale
    });
    if (projections.status !== "unavailable") {
      const byId = new Map(projections.items.map((item) => [item.id, item]));
      const changes: SourceChange[] = stale.map((entityId) => ({
        id: `sweep:${state.entityType}:${entityId}`,
        entityType: state.entityType,
        entityId,
        sourceVersion: `sweep:${projections.observedAt}`,
        eventType: "upsert",
        observedAt: projections.observedAt,
        target: { entityType: portalEntityType, entityId },
        entity: byId.get(entityId) ?? null
      }));
      const written = await persistCarbonChangePage(runtime.pool, principal, {
        sourceId: runtime.source.sourceId,
        automationUserId: runtime.automationUserId,
        plan: planCarbonChanges(changes)
      });
      refreshed = written.upserted + written.tombstoned;
    }
  }
  return {
    entityType: state.entityType,
    listed: versions.items.length,
    refreshed,
    tombstoned,
    done,
    status: versions.status
  };
}

function requestedCompany(event: unknown): string | undefined {
  const data =
    event && typeof event === "object" && "data" in event
      ? (event as { data?: unknown }).data
      : undefined;
  const companyId =
    data && typeof data === "object"
      ? (data as Record<string, unknown>).companyId
      : undefined;
  return typeof companyId === "string" ? companyId : undefined;
}

export function createCarbonChangeFunction(runtime: CarbonChangeRuntime) {
  return portalInngest.createFunction(
    {
      id: "portal-carbon-changes",
      retries: 3,
      concurrency: [{ limit: 1, key: "event.data.companyId" }]
    },
    [{ event: "portal/carbon.changes" }, { cron: "*/1 * * * *" }],
    async ({ event, step }) => {
      const requested = requestedCompany(event);
      const companies = requested
        ? runtime.companies.filter((entry) => entry.companyId === requested)
        : runtime.companies;
      let applied = 0;
      for (const company of companies) {
        // A backlog drains a few pages per run; the cron picks up the rest.
        // Step outputs carry counts and ids only, never a projection.
        for (let page = 0; page < CARBON_CHANGE_PAGES_PER_RUN; page += 1) {
          const result = await step.run(
            `pull-${company.companyId}-${page}`,
            async () => {
              const pulled = await pullCarbonChanges(runtime, company);
              return {
                claimed: pulled.claimed,
                acknowledged: pulled.acknowledged,
                unacknowledged: pulled.unacknowledged.length,
                status: pulled.status
              };
            }
          );
          applied += result.acknowledged;
          if (
            result.status === "unavailable" ||
            result.claimed < CARBON_CHANGE_PAGE_LIMIT
          )
            break;
        }
      }
      return { applied };
    }
  );
}

export function createCarbonReconciliationFunction(
  runtime: CarbonChangeRuntime
) {
  return portalInngest.createFunction(
    {
      id: "portal-carbon-reconcile",
      retries: 2,
      concurrency: [{ limit: 1, key: "event.data.companyId" }]
    },
    [{ event: "portal/carbon.reconcile" }, { cron: "*/15 * * * *" }],
    async ({ event, step }) => {
      const requested = requestedCompany(event);
      const companies = requested
        ? runtime.companies.filter((entry) => entry.companyId === requested)
        : runtime.companies;
      const pages: Array<{
        companyId: string;
        entityType: string;
        done: boolean;
      }> = [];
      for (const company of companies) {
        const result = await step.run(`sweep-${company.companyId}`, () =>
          sweepCarbonEntities(runtime, company)
        );
        pages.push({
          companyId: company.companyId,
          entityType: result.entityType,
          done: result.done
        });
      }
      return { pages };
    }
  );
}
