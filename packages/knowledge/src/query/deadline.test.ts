import { expect, it, vi } from "vitest";
import { withDeadline } from "./deadline.server";

it("rejects at the deadline even when a dependency ignores abort", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const result = withDeadline(100, async (value) => {
    signal = value;
    return new Promise<string>(() => {});
  });
  const assertion = expect(result).rejects.toThrow("Deadline exceeded");
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(signal?.aborted).toBe(true);
  vi.useRealTimers();
});
it("propagates caller cancellation and clears completed timers", async () => {
  const caller = new AbortController();
  caller.abort();
  await expect(
    withDeadline(100, async () => "should not run", caller.signal)
  ).rejects.toThrow();
  expect(await withDeadline(100, async () => "done")).toBe("done");
});
