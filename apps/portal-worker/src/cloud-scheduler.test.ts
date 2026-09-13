import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  confirm: vi.fn(),
  acknowledge: vi.fn(),
  backlog: vi.fn(),
  invalidate: vi.fn(),
  transaction: vi.fn()
}));
vi.mock("@carbon/portal/indexing/outbox.server", async (original) => ({
  ...(await original<typeof import("@carbon/portal/indexing/outbox.server")>()),
  claimOutbox: mocks.claim,
  confirmOutboxApplied: mocks.confirm,
  acknowledgeOutbox: mocks.acknowledge,
  outboxBacklog: mocks.backlog
}));
vi.mock("@carbon/portal/database.server", () => ({
  withPortalTransaction: mocks.transaction
}));
vi.mock("./invalidation", () => ({
  applyOutboxInvalidation: mocks.invalidate
}));

import {
  createCloudSchedulerHandler,
  drainScheduledOutbox,
  readSchedulerConfiguration,
  type SchedulerRuntime
} from "./cloud-scheduler";

const configuration = {
  audience: "https://ingest.example.com",
  subject: "123456789012345678901"
};
const principal = {
  companyId: "company",
  callerId: "worker",
  sourceId: "manual"
};
const event = {
  id: "event",
  sourceId: "manual",
  entityType: "intake",
  entityId: "intake",
  sourceVersion: "1",
  eventType: "upsert" as const,
  payload: {}
};
function runtime(): SchedulerRuntime {
  return {
    pool: {} as SchedulerRuntime["pool"],
    companies: [principal],
    sourceId: "manual",
    process: vi.fn().mockResolvedValue(undefined)
  };
}
function claims() {
  const now = Math.floor((performance.timeOrigin + performance.now()) / 1000);
  return {
    iss: "https://accounts.google.com",
    sub: configuration.subject,
    aud: configuration.audience,
    iat: now,
    exp: now + 3600
  };
}
function request(path = "check", init: RequestInit = {}) {
  return new Request(`https://ingest.example.com/internal/outbox/${path}`, {
    method: "POST",
    headers: { authorization: "Bearer header.payload.signature" },
    ...init
  });
}
function verifier(overrides = {}) {
  return {
    verifyServiceToken: vi.fn().mockResolvedValue({ ...claims(), ...overrides })
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.claim.mockResolvedValue([]);
  mocks.invalidate.mockResolvedValue({ acknowledged: [], deferred: [] });
  mocks.transaction.mockResolvedValue(undefined);
});

it("performs authenticated readiness reads without claiming, parsing, or acknowledging", async () => {
  const deps = runtime();
  const tokens = verifier();
  const response = await createCloudSchedulerHandler(
    configuration,
    deps,
    tokens
  )(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ready", principals: 1 });
  expect(tokens.verifyServiceToken).toHaveBeenCalledWith(
    "header.payload.signature",
    configuration.audience
  );
  expect(mocks.backlog).toHaveBeenCalledWith(deps.pool, principal);
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(deps.process).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});
it.each([
  { sub: "999" },
  { iss: "https://issuer.example.com" },
  { aud: "https://other.example.com" },
  { aud: [configuration.audience] },
  { exp: 1 },
  { iat: 9_999_999_999 },
  { exp: undefined },
  { iat: undefined }
])("denies incorrect signed claims before database access: %j", async (overrides) => {
  const response = await createCloudSchedulerHandler(
    configuration,
    runtime(),
    verifier(overrides)
  )(request("drain"));
  expect(response.status).toBe(401);
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it("denies a failed signature verification before any work", async () => {
  const tokens = {
    verifyServiceToken: vi.fn().mockRejectedValue(Error("Invalid signature"))
  };
  expect(
    (
      await createCloudSchedulerHandler(
        configuration,
        runtime(),
        tokens
      )(request("drain"))
    ).status
  ).toBe(401);
  expect(mocks.claim).not.toHaveBeenCalled();
});
const rejectedHeaders: Record<string, string>[] = [
  {},
  { authorization: "Bearer not-a-jwt" },
  {
    authorization: "Bearer header.payload.signature",
    "x-serverless-authorization": "Bearer header.payload.signature"
  }
];
it.each(
  rejectedHeaders
)("denies malformed or conflicting identity headers before the verifier: %j", async (headers) => {
  const tokens = verifier();
  expect(
    (
      await createCloudSchedulerHandler(
        configuration,
        runtime(),
        tokens
      )(request("drain", { headers }))
    ).status
  ).toBe(401);
  expect(tokens.verifyServiceToken).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it.each([
  request("drain", { body: '{"companyId":"another"}' }),
  request("drain?sourceId=another")
])("refuses body or query tenant selectors", async (input) => {
  expect(
    (
      await createCloudSchedulerHandler(
        configuration,
        runtime(),
        verifier()
      )(input)
    ).status
  ).toBe(400);
  expect(mocks.claim).not.toHaveBeenCalled();
});
it("returns unavailable when the configured source cannot be read", async () => {
  mocks.transaction.mockRejectedValue(Error("Unavailable"));
  expect(
    (
      await createCloudSchedulerHandler(
        configuration,
        runtime(),
        verifier()
      )(request())
    ).status
  ).toBe(503);
  expect(mocks.claim).not.toHaveBeenCalled();
});
it("fails readiness when the database monitor cannot publish", async () => {
  const deps = {
    ...runtime(),
    observeDatabase: vi.fn().mockRejectedValue(Error("Unavailable"))
  };
  expect(
    (
      await createCloudSchedulerHandler(
        configuration,
        deps,
        verifier()
      )(request())
    ).status
  ).toBe(503);
  expect(mocks.claim).not.toHaveBeenCalled();
});
it("prioritizes invalidation, claims one delivery with a long lease, then confirms before acknowledgment", async () => {
  const order: string[] = [];
  mocks.claim
    .mockResolvedValueOnce([{ ...event, eventType: "acl-change" }])
    .mockResolvedValueOnce([event]);
  mocks.invalidate.mockImplementation(async () => {
    order.push("invalidate");
    return { acknowledged: ["invalidation"], deferred: [] };
  });
  const deps = runtime();
  deps.process = vi.fn().mockImplementation(async () => {
    order.push("process");
  });
  mocks.confirm.mockImplementation(async () => {
    order.push("confirm");
  });
  mocks.acknowledge.mockImplementation(async () => {
    order.push("acknowledge");
  });
  const result = await drainScheduledOutbox(deps, new AbortController().signal);
  expect(result).toEqual({ delivered: 1, invalidated: 1 });
  expect(order).toEqual(["invalidate", "process", "confirm", "acknowledge"]);
  expect(mocks.claim.mock.calls[1]).toEqual([
    deps.pool,
    principal,
    expect.stringContaining("portal-scheduler-"),
    1,
    ["upsert"],
    600
  ]);
});
it("does not process delivery when invalidation was deferred", async () => {
  mocks.invalidate.mockResolvedValue({
    acknowledged: [],
    deferred: ["revocation"]
  });
  const deps = runtime();
  await expect(
    drainScheduledOutbox(deps, new AbortController().signal)
  ).rejects.toThrow();
  expect(deps.process).not.toHaveBeenCalled();
});
it("does not confirm or acknowledge aborted processing", async () => {
  mocks.claim.mockResolvedValueOnce([]).mockResolvedValueOnce([event]);
  const controller = new AbortController();
  const deps = runtime();
  deps.process = vi.fn().mockImplementation(async () => {
    controller.abort();
  });
  await expect(drainScheduledOutbox(deps, controller.signal)).rejects.toThrow();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});
it("gives overlapping invocations distinct lease owners", async () => {
  await Promise.all([
    drainScheduledOutbox(runtime(), new AbortController().signal),
    drainScheduledOutbox(runtime(), new AbortController().signal)
  ]);
  const owners = mocks.claim.mock.calls.map((call) => call[2]);
  expect(new Set(owners).size).toBe(2);
});
it.each([
  { PORTAL_SCHEDULER_MODE: "wrong" },
  { PORTAL_SCHEDULER_MODE: "cloud-scheduler" },
  {
    PORTAL_SCHEDULER_MODE: "cloud-scheduler",
    PORTAL_RELEASE_PROFILE: "manual-v1",
    PORTAL_SCHEDULER_AUDIENCE: "http://ingest.example.com",
    PORTAL_SCHEDULER_SUBJECT: configuration.subject
  },
  {
    PORTAL_SCHEDULER_MODE: "cloud-scheduler",
    PORTAL_RELEASE_PROFILE: "manual-v1",
    PORTAL_SCHEDULER_AUDIENCE: configuration.audience,
    PORTAL_SCHEDULER_SUBJECT: "scheduler@example.com"
  }
])("rejects incomplete or invalid scheduler configuration: %j", (environment) => {
  expect(() => readSchedulerConfiguration(environment)).toThrow();
});
it("preserves the absent scheduler configuration for existing Inngest deployments", () => {
  expect(readSchedulerConfiguration({})).toBeNull();
});

it("bounds a stalled Google signature verification before database access", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const tokens = {
      verifyServiceToken: vi
        .fn()
        .mockImplementation(() => Promise.withResolvers<never>().promise)
    };
    let status: number | undefined;
    const pending = createCloudSchedulerHandler(
      configuration,
      runtime(),
      tokens
    )(request("drain")).then((response) => {
      status = response.status;
    });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(status).toBe(401);
    await pending;
    expect(mocks.claim).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("accepts explicitly selected Inngest without Cloud Scheduler identity fields", () => {
  expect(
    readSchedulerConfiguration({ PORTAL_SCHEDULER_MODE: "inngest" })
  ).toBeNull();
  expect(() =>
    readSchedulerConfiguration({
      PORTAL_SCHEDULER_MODE: "inngest",
      PORTAL_SCHEDULER_SUBJECT: configuration.subject
    })
  ).toThrow();
});

it("reports database monitoring failure without changing committed work or leaking diagnostics", async () => {
  mocks.claim.mockResolvedValueOnce([]).mockResolvedValueOnce([event]);
  const deps = {
    ...runtime(),
    observeDatabase: vi
      .fn()
      .mockRejectedValue(
        Error("synthetic private provider diagnostic token=example-secret")
      )
  };
  const records: unknown[] = [];
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      records.push(JSON.parse(String(chunk)));
      return true;
    });
  try {
    const response = await createCloudSchedulerHandler(
      configuration,
      deps,
      verifier()
    )(request("drain"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: 1, invalidated: 0 });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.acknowledge).toHaveBeenCalledOnce();
    expect(records).toEqual([
      {
        schemaVersion: 1,
        service: "worker",
        requestId: expect.any(String),
        stage: "indexing",
        outcome: "error"
      }
    ]);
    expect(JSON.stringify(records)).not.toContain("example-secret");
    expect(JSON.stringify(records)).not.toContain(principal.companyId);
  } finally {
    output.mockRestore();
  }
});
