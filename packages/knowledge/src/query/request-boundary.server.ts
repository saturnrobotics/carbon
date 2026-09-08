import {
  createTelemetry,
  type Telemetry,
  type TelemetryRecord
} from "../telemetry";
import { withDeadline } from "./deadline.server";

const traces = new WeakMap<Request, Telemetry>();
export function requestTelemetry(
  request: Request,
  service: TelemetryRecord["service"]
) {
  const existing = traces.get(request);
  if (existing) return existing;
  const trace = createTelemetry(service);
  traces.set(request, trace);
  return trace;
}
export function requestBoundary(
  service: TelemetryRecord["service"],
  handler: (request: Request) => Promise<Response>,
  options: {
    milliseconds?: number;
    sink?: (record: TelemetryRecord) => void;
  } = {}
) {
  return async (request: Request): Promise<Response> => {
    const trace = createTelemetry(service, options.sink);
    const started = performance.now();
    let result: Response;
    try {
      result = await withDeadline(
        options.milliseconds ?? 10000,
        async (signal) => {
          const bounded = new Request(request, { signal });
          traces.set(bounded, trace);
          return handler(bounded);
        },
        request.signal
      );
    } catch (error) {
      const timeout =
        error instanceof Error && error.message === "Deadline exceeded";
      result = Response.json(
        {
          error: timeout ? "request_deadline_exceeded" : "service_unavailable"
        },
        { status: timeout ? 504 : 503 }
      );
    }
    trace.record(
      "request",
      result.status === 504
        ? "timeout"
        : result.status >= 500
          ? "error"
          : result.status >= 400
            ? "deny"
            : "success",
      { durationMs: performance.now() - started, status: result.status }
    );
    const headers = new Headers(result.headers);
    headers.set("x-request-id", trace.id);
    headers.set("cache-control", "no-store");
    return new Response(result.body, { status: result.status, headers });
  };
}
