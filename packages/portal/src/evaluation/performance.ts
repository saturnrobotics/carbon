export type PerformanceMeasurement = {
  durationMs: number;
  ok: boolean;
  recalled: boolean;
};

function percentile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function summarizeMeasurements(
  measurements: readonly PerformanceMeasurement[]
) {
  const durations = measurements
    .map((entry) => entry.durationMs)
    .sort((left, right) => left - right);
  const successful = measurements.filter((entry) => entry.ok);
  const errors = measurements.length - successful.length;
  return {
    count: measurements.length,
    errors,
    errorRate: measurements.length ? errors / measurements.length : 0,
    recallAt10: successful.length
      ? successful.filter((entry) => entry.recalled).length / successful.length
      : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99)
  };
}
