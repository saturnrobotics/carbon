import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";

/** Only a competing write to this single time series can be retried safely.
 * https://cloud.google.com/monitoring/api/troubleshooting#errors_writing_metric_data
 */
async function isPointCollision(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  const payload = (await response.json()) as {
    error?: { status?: unknown; message?: unknown };
  };
  if (
    payload.error?.status !== "INVALID_ARGUMENT" &&
    payload.error?.status !== "FAILED_PRECONDITION"
  )
    return false;
  const message = payload.error.message;
  return (
    typeof message === "string" &&
    (message.includes(
      "One or more points were written more frequently than the maximum sampling period configured for the metric"
    ) ||
      message.includes(
        "Points must be written in order. One or more of the points specified had an older end time than the most recent point"
      ))
  );
}

/** Emit aggregate connection pressure, never users, queries or tenant data. */
export function createDatabaseConnectionObserver(options: {
  pool: Pool;
  project: string;
  metricType: string;
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): (signal?: AbortSignal) => Promise<void> {
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project) ||
    !/^custom\.googleapis\.com\/[a-zA-Z0-9_./-]+$/.test(options.metricType)
  )
    throw new Error("Database monitoring configuration is invalid");
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait =
    options.wait ??
    ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  return async (parentSignal) => {
    const deadline = AbortSignal.timeout(20_000);
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, deadline])
      : deadline;
    try {
      let accessToken: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        // PostgreSQL supplies the timestamp so sampling and formatting use one
        // database clock. Only aggregate statistics are read, with a bounded query.
        const query = {
          text: `SELECT sum(numbackends)::double precision / current_setting('max_connections')::integer AS utilization,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endTime"
          FROM pg_catalog.pg_stat_database`,
          query_timeout: 2_000
        };
        const result = await options.pool.query<{
          utilization: number;
          endTime: string;
        }>(query);
        signal.throwIfAborted();
        const sample = result.rows[0];
        if (
          !sample ||
          typeof sample.utilization !== "number" ||
          !Number.isFinite(sample.utilization) ||
          sample.utilization < 0 ||
          typeof sample.endTime !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(sample.endTime)
        )
          throw new Error("Invalid measurement");
        if (!accessToken) {
          const identity = await fetchImpl(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            {
              headers: { "Metadata-Flavor": "Google" },
              signal
            }
          );
          if (!identity.ok) throw new Error("Identity unavailable");
          const credentials = (await identity.json()) as {
            access_token?: unknown;
          };
          if (
            typeof credentials.access_token !== "string" ||
            !credentials.access_token.trim()
          )
            throw new Error("Identity unavailable");
          accessToken = credentials.access_token;
        }
        signal.throwIfAborted();
        const response = await fetchImpl(
          `https://monitoring.googleapis.com/v3/projects/${options.project}/timeSeries`,
          {
            method: "POST",
            signal,
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              timeSeries: [
                {
                  metric: { type: options.metricType },
                  resource: {
                    type: "global",
                    labels: { project_id: options.project }
                  },
                  metricKind: "GAUGE",
                  valueType: "DOUBLE",
                  points: [
                    {
                      interval: { endTime: sample.endTime },
                      value: { doubleValue: sample.utilization }
                    }
                  ]
                }
              ]
            })
          }
        );
        if (response.ok) return;
        if (attempt === 2 || !(await isPointCollision(response)))
          throw new Error("Metric write failed");
        // Concurrent scheduler/check requests share one global gauge. Wait beyond
        // its five-second minimum and read a new sample, never resend an old point.
        await wait(5_100, signal);
      }
    } catch {
      throw new Error("Database monitoring unavailable");
    }
  };
}
