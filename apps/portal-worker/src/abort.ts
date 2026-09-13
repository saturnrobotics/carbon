/** Stop awaiting transport work at the request deadline; callers check before writes. */
export async function withAbortSignal<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
