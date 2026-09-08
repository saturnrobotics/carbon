/** Bounds delivery even for a dependency that ignores cancellation. Callers must
 * also pass the signal to providers and retain database statement timeouts. */
export async function withDeadline<T>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal
): Promise<T> {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 120_000
  )
    throw Error("Invalid deadline");
  if (parent?.aborted) throw Error("Request canceled");
  const controller = new AbortController();
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const cancel = () => {
    controller.abort();
    rejectDeadline(Error("Request canceled"));
  };
  parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(Error("Deadline exceeded"));
  }, milliseconds);
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadline
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}
