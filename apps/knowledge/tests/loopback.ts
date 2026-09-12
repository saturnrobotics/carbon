/**
 * The one place that decides whether a browser-test target is acceptable.
 *
 * The harness used to pin whole origins by string equality, which made the
 * loopback guarantee and the port choice the same decision: a second harness
 * on one machine could not move a port without dropping the guarantee. This
 * keeps the guarantee — loopback host, expected scheme, no credentials, no
 * path, query or fragment — and lets the port move.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function assertLoopbackOrigin(
  name: string,
  value: string,
  protocol: "http:" | "https:"
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a loopback test origin`);
  }
  if (
    parsed.protocol !== protocol ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(`${name} must be a loopback test origin`);
  return parsed.href;
}
