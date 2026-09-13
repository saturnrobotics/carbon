import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { createDatabaseConnectionObserver } from "./database-monitoring";

function fixture() {
  const query = vi.fn().mockResolvedValue({
    rows: [{ utilization: 0.25, endTime: "2026-09-13T00:00:00.000Z" }]
  });
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const wait = vi
    .fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>()
    .mockResolvedValue(undefined);
  const observe = createDatabaseConnectionObserver({
    pool: { query } as unknown as Pool,
    project: "example-project",
    metricType: "custom.googleapis.com/portal/database_connection_utilization",
    fetchImpl,
    wait
  });
  return { query, fetchImpl, observe, wait };
}

it("writes a measured database utilization sample using the attached workload identity", async () => {
  const { query, fetchImpl, observe } = fixture();
  await observe();
  expect(query).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenNthCalledWith(
    1,
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    expect.objectContaining({ headers: { "Metadata-Flavor": "Google" } })
  );
  const [url, request] = fetchImpl.mock.calls[1]!;
  expect(url).toBe(
    "https://monitoring.googleapis.com/v3/projects/example-project/timeSeries"
  );
  expect(request?.headers).toEqual({
    authorization: "Bearer synthetic-token",
    "content-type": "application/json"
  });
  expect(JSON.parse(request?.body as string)).toEqual({
    timeSeries: [
      {
        metric: {
          type: "custom.googleapis.com/portal/database_connection_utilization"
        },
        resource: { type: "global", labels: { project_id: "example-project" } },
        metricKind: "GAUGE",
        valueType: "DOUBLE",
        points: [
          {
            interval: { endTime: "2026-09-13T00:00:00.000Z" },
            value: { doubleValue: 0.25 }
          }
        ]
      }
    ]
  });
});

it("refuses absent or invalid measurements before requesting credentials", async () => {
  for (const rows of [
    [],
    [{ utilization: null }],
    [{ utilization: -1 }],
    [{ utilization: Number.NaN }]
  ]) {
    const { query, fetchImpl, observe } = fixture();
    query.mockResolvedValue({ rows });
    await expect(observe()).rejects.toThrow("Database monitoring unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  }
});

it("rejects metadata and metric-write failures without exposing provider diagnostics", async () => {
  for (const failedCall of [0, 1]) {
    const { fetchImpl, observe } = fixture();
    fetchImpl.mockReset();
    if (failedCall === 1)
      fetchImpl.mockResolvedValueOnce(
        Response.json({ access_token: "synthetic-token" })
      );
    fetchImpl.mockResolvedValueOnce(
      new Response("private provider diagnostic", { status: 403 })
    );
    await expect(observe()).rejects.toThrow(
      /^Database monitoring unavailable$/
    );
    expect(fetchImpl).toHaveBeenCalledTimes(failedCall + 1);
  }
});

it("does no work after its request deadline is aborted", async () => {
  const { query, fetchImpl, observe } = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(observe(controller.signal)).rejects.toThrow(
    "Database monitoring unavailable"
  );
  expect(query).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("refuses missing configuration and credentialed or unscoped targets", () => {
  for (const [project, metricType] of [
    ["", "custom.googleapis.com/x"],
    ["example/project", "custom.googleapis.com/x"],
    ["example-project", ""]
  ]) {
    expect(() =>
      createDatabaseConnectionObserver({
        pool: {} as Pool,
        project: project!,
        metricType: metricType!
      })
    ).toThrow("Database monitoring configuration is invalid");
  }
});

const spacingMessage =
  "One or more points were written more frequently than the maximum sampling period configured for the metric.";
const orderingMessage =
  "Points must be written in order. One or more of the points specified had an older end time than the most recent point.";
function writeError(
  message: string,
  status = "FAILED_PRECONDITION",
  code = 400
) {
  return Response.json({ error: { code, status, message } }, { status: code });
}

it.each([
  ["FAILED_PRECONDITION", spacingMessage],
  ["INVALID_ARGUMENT", spacingMessage],
  ["INVALID_ARGUMENT", orderingMessage]
])("waits at least five seconds and resamples before retrying a %s time-series collision", async (status, message) => {
  const { query, fetchImpl, observe, wait } = fixture();
  query
    .mockResolvedValueOnce({
      rows: [{ utilization: 0.25, endTime: "2026-09-13T00:00:00.000Z" }]
    })
    .mockResolvedValueOnce({
      rows: [{ utilization: 0.5, endTime: "2026-09-13T00:00:05.100Z" }]
    });
  fetchImpl
    .mockReset()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(writeError(message, status))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  await observe();
  expect(query).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledOnce();
  expect(wait.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(5_000);
  expect(wait.mock.invocationCallOrder[0]).toBeLessThan(
    query.mock.invocationCallOrder[1]!
  );
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  const initial = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string);
  const retry = JSON.parse(fetchImpl.mock.calls[2]?.[1]?.body as string);
  expect(initial.timeSeries[0].points[0]).toEqual({
    interval: { endTime: "2026-09-13T00:00:00.000Z" },
    value: { doubleValue: 0.25 }
  });
  expect(retry.timeSeries[0].points[0]).toEqual({
    interval: { endTime: "2026-09-13T00:00:05.100Z" },
    value: { doubleValue: 0.5 }
  });
});

it("bounds repeated point collisions to three attempts", async () => {
  const { query, fetchImpl, observe, wait } = fixture();
  fetchImpl
    .mockReset()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockImplementation(async () => writeError(spacingMessage));
  await expect(observe()).rejects.toThrow(/^Database monitoring unavailable$/);
  expect(query).toHaveBeenCalledTimes(3);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(wait).toHaveBeenCalledTimes(2);
});

it.each([
  [
    400,
    "INVALID_ARGUMENT",
    "Value type DOUBLE does not match metric descriptor value type INT64."
  ],
  [
    400,
    "FAILED_PRECONDITION",
    "One or more points arrived late outside of its aggregation window"
  ],
  [403, "PERMISSION_DENIED", spacingMessage],
  [401, "UNAUTHENTICATED", orderingMessage],
  [429, "RESOURCE_EXHAUSTED", "Metric quota exhausted"],
  [
    400,
    "INVALID_ARGUMENT",
    "Points must be written in order. One or more of the points specified had an older start time than the most recent point."
  ]
])("does not retry unrelated %s %s errors", async (code, status, message) => {
  const { query, fetchImpl, observe, wait } = fixture();
  fetchImpl
    .mockReset()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(writeError(message, status, code));
  await expect(observe()).rejects.toThrow(/^Database monitoring unavailable$/);
  expect(query).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(wait).not.toHaveBeenCalled();
});

it("stops after cancellation during the retry delay", async () => {
  const { query, fetchImpl, observe, wait } = fixture();
  const controller = new AbortController();
  wait.mockImplementation(async () => controller.abort());
  fetchImpl
    .mockReset()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(writeError(spacingMessage));
  await expect(observe(controller.signal)).rejects.toThrow(
    /^Database monitoring unavailable$/
  );
  expect(query).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledOnce();
});

it("fails closed on a malformed Monitoring error response", async () => {
  const { query, fetchImpl, observe, wait } = fixture();
  fetchImpl
    .mockReset()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(
      new Response("private upstream error", { status: 400 })
    );
  await expect(observe()).rejects.toThrow(/^Database monitoring unavailable$/);
  expect(query).toHaveBeenCalledOnce();
  expect(wait).not.toHaveBeenCalled();
});

it("does not mask an authorization failure after a retryable collision", async () => {
  const { query, fetchImpl, observe, wait } = fixture();
  fetchImpl
    .mockReset()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(writeError(spacingMessage))
    .mockResolvedValueOnce(
      writeError("Permission denied", "PERMISSION_DENIED", 403)
    );
  await expect(observe()).rejects.toThrow(/^Database monitoring unavailable$/);
  expect(query).toHaveBeenCalledTimes(2);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledOnce();
});
