import { randomUUID } from "node:crypto";
import { INVALIDATION_EVENT_TYPES } from "@carbon/portal/cache/epochs.server";
import { withPortalTransaction } from "@carbon/portal/database.server";
import {
  GoogleWorkforceTokenVerifier,
  type TrustedTokenVerifier
} from "@carbon/portal/identity.server";
import {
  acknowledgeOutbox,
  claimOutbox,
  confirmOutboxApplied,
  DELIVERY_EVENT_TYPES,
  type LeasedOutboxEvent,
  outboxBacklog
} from "@carbon/portal/indexing/outbox.server";
import { createTelemetry } from "@carbon/portal/telemetry";
import type { Pool } from "pg";
import { withAbortSignal } from "./abort";
import { applyOutboxInvalidation } from "./invalidation";

export const SCHEDULER_DEADLINE_MS = 390_000;
export const SCHEDULER_LEASE_SECONDS = 600;
export type SchedulerConfiguration = { audience: string; subject: string };
export type SchedulerPrincipal = {
  companyId: string;
  callerId: string;
  sourceId: string;
};
export type SchedulerRuntime = {
  pool: Pool;
  companies: readonly { companyId: string; callerId: string }[];
  sourceId: string;
  process: (
    principal: SchedulerPrincipal,
    event: LeasedOutboxEvent,
    signal: AbortSignal
  ) => Promise<void>;
  observeDatabase?: (signal?: AbortSignal) => Promise<void>;
  observeBacklog?: (principal: SchedulerPrincipal) => Promise<void>;
};

export function readSchedulerConfiguration(
  environment: NodeJS.ProcessEnv
): SchedulerConfiguration | null {
  if (
    (environment.PORTAL_SCHEDULER_MODE === undefined ||
      environment.PORTAL_SCHEDULER_MODE === "inngest") &&
    environment.PORTAL_SCHEDULER_AUDIENCE === undefined &&
    environment.PORTAL_SCHEDULER_SUBJECT === undefined &&
    environment.PORTAL_DATABASE_METRIC_TYPE === undefined
  )
    return null;
  if (
    environment.PORTAL_SCHEDULER_MODE !== "cloud-scheduler" ||
    environment.PORTAL_RELEASE_PROFILE !== "manual-v1"
  )
    throw Error("Invalid scheduler mode");
  const audience = environment.PORTAL_SCHEDULER_AUDIENCE;
  const subject = environment.PORTAL_SCHEDULER_SUBJECT;
  try {
    if (!audience || !subject || !/^\d{1,32}$/.test(subject)) throw Error();
    const url = new URL(audience);
    if (
      url.protocol !== "https:" ||
      url.origin !== audience ||
      url.username ||
      url.password
    )
      throw Error();
  } catch {
    throw Error("Invalid scheduler identity configuration");
  }
  return { audience, subject };
}

function principals(runtime: SchedulerRuntime): SchedulerPrincipal[] {
  if (
    !runtime.sourceId ||
    !runtime.companies.length ||
    runtime.companies.length > 100 ||
    runtime.companies.some((company) => !company.companyId || !company.callerId)
  )
    throw Error("Scheduler has no valid worker principals");
  return runtime.companies.map((company) => ({
    ...company,
    sourceId: runtime.sourceId
  }));
}

/** Read-only proof: the configured role can see its active library and outbox. */
async function checkRuntime(runtime: SchedulerRuntime, signal: AbortSignal) {
  for (const principal of principals(runtime)) {
    signal.throwIfAborted();
    await withPortalTransaction(
      runtime.pool,
      principal,
      "read",
      async (client) => {
        const source = await client.query(
          `SELECT 1 FROM portal.source WHERE "companyId"=$1 AND id=$2 AND kind='upload' AND status='active'`,
          [principal.companyId, principal.sourceId]
        );
        if (!source.rows.length)
          throw Error("Scheduler library is unavailable");
      }
    );
    signal.throwIfAborted();
    await outboxBacklog(runtime.pool, principal);
  }
}

/** Await durable work: Cloud Run must never acknowledge a background promise. */
export async function drainScheduledOutbox(
  runtime: SchedulerRuntime,
  signal: AbortSignal
) {
  const workerId = `portal-scheduler-${randomUUID()}`;
  const companies = principals(runtime);
  let invalidated = 0;
  for (const principal of companies) {
    signal.throwIfAborted();
    const events = await claimOutbox(
      runtime.pool,
      principal,
      workerId,
      50,
      INVALIDATION_EVENT_TYPES,
      SCHEDULER_LEASE_SECONDS
    );
    signal.throwIfAborted();
    const result = await applyOutboxInvalidation(
      runtime.pool,
      principal,
      workerId,
      events,
      signal
    );
    invalidated += result.acknowledged.length;
    if (result.deferred.length)
      throw Error("Scheduler invalidation was deferred");
  }
  let delivered = 0;
  for (const principal of companies) {
    signal.throwIfAborted();
    const [event] = await claimOutbox(
      runtime.pool,
      principal,
      workerId,
      1,
      DELIVERY_EVENT_TYPES,
      SCHEDULER_LEASE_SECONDS
    );
    signal.throwIfAborted();
    if (!event) continue;
    await withAbortSignal(signal, () =>
      runtime.process(principal, event, signal)
    );
    signal.throwIfAborted();
    await confirmOutboxApplied(runtime.pool, principal, event, "manual-v1");
    signal.throwIfAborted();
    await acknowledgeOutbox(runtime.pool, principal, workerId, [event.id]);
    delivered = 1;
    break;
  }
  for (const principal of companies) {
    signal.throwIfAborted();
    await runtime.observeBacklog?.(principal);
  }
  return { delivered, invalidated };
}

export function createCloudSchedulerHandler(
  configuration: SchedulerConfiguration,
  runtime: SchedulerRuntime,
  verifier: Pick<
    TrustedTokenVerifier,
    "verifyServiceToken"
  > = new GoogleWorkforceTokenVerifier()
) {
  principals(runtime);
  return async (request: Request): Promise<Response> => {
    const response = (status: number, body: Record<string, unknown>) =>
      Response.json(body, { status, headers: { "cache-control": "no-store" } });
    const url = new URL(request.url);
    if (
      !["/internal/outbox/check", "/internal/outbox/drain"].includes(
        url.pathname
      )
    )
      return response(404, { error: "not_found" });
    if (request.method !== "POST")
      return response(405, { error: "method_not_allowed" });
    const authentication = new AbortController();
    const authenticationTimer = setTimeout(
      () => authentication.abort(),
      10_000
    );
    try {
      if (request.headers.has("x-serverless-authorization")) throw Error();
      const authorization = request.headers.get("authorization") ?? "";
      if (
        authorization.length > 16_384 ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          authorization
        )
      )
        throw Error();
      const claims = await withAbortSignal(
        AbortSignal.any([request.signal, authentication.signal]),
        () =>
          verifier.verifyServiceToken(
            authorization.slice(7),
            configuration.audience
          )
      );
      const now = Math.floor(
        (performance.timeOrigin + performance.now()) / 1000
      );
      if (
        !["accounts.google.com", "https://accounts.google.com"].includes(
          claims.iss ?? ""
        ) ||
        claims.sub !== configuration.subject ||
        claims.aud !== configuration.audience ||
        !Number.isInteger(claims.iat) ||
        !Number.isInteger(claims.exp) ||
        claims.iat! > now + 30 ||
        claims.exp! <= now ||
        claims.exp! <= claims.iat! ||
        claims.exp! - claims.iat! > 3_600
      )
        throw Error();
    } catch {
      return response(401, { error: "unauthorized" });
    } finally {
      clearTimeout(authenticationTimer);
    }
    // No client-supplied tenant/source selectors, even from the scheduler identity.
    if (url.search || request.body !== null)
      return response(400, { error: "empty_request_required" });
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) controller.abort();
    const timer = setTimeout(abort, SCHEDULER_DEADLINE_MS);
    try {
      if (url.pathname.endsWith("/check")) {
        await withAbortSignal(controller.signal, () =>
          checkRuntime(runtime, controller.signal)
        );
        await withAbortSignal(
          controller.signal,
          () =>
            runtime.observeDatabase?.(controller.signal) ?? Promise.resolve()
        );
        return response(200, {
          status: "ready",
          principals: runtime.companies.length
        });
      }
      const result = await withAbortSignal(controller.signal, () =>
        drainScheduledOutbox(runtime, controller.signal)
      );
      try {
        await withAbortSignal(
          controller.signal,
          () =>
            runtime.observeDatabase?.(controller.signal) ?? Promise.resolve()
        );
      } catch {
        // Existing indexing-error alerts also cover loss of worker monitoring.
        // The telemetry allowlist never receives provider diagnostics or identities.
        createTelemetry("worker").record("indexing", "error");
      }
      return response(200, result);
    } catch {
      return response(503, { error: "scheduler_unavailable" });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    }
  };
}
