import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { waitForClientNavigation } from "./harness/browser";

const container =
  process.env.KNOWLEDGE_E2E_DATABASE_CONTAINER ?? "knowledge-schema-test";
const expectedPort = process.env.KNOWLEDGE_E2E_DATABASE_PORT ?? "59910";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A browser-test origin must be a bare loopback origin on the expected
 * scheme: no credentials, no path, no query, no fragment, no other host. The
 * PORT is deliberately free, so a second synthetic stack can run beside one
 * that is already up; what keeps the suite off real data is the labelled
 * disposable database below, not the port number. */
export function loopbackTestOrigin(
  name: string,
  fallback: string,
  protocol: "http:" | "https:"
): string {
  const value = process.env[name] ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a loopback test origin`);
  }
  if (
    parsed.protocol !== protocol ||
    !LOOPBACK_HOSTNAMES.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(`${name} must be a loopback test origin`);
  return parsed.href;
}

/** Refuse to run browser tests unless the supplied database is the known labelled
 * disposable fixture. The local services then clean only captured intake IDs. */
function assertDisposableFixture() {
  const url = process.env.KNOWLEDGE_E2E_DATABASE_URL;
  if (!url || process.env.KNOWLEDGE_E2E_SYNTHETIC_FIXTURES !== "1") {
    throw new Error(
      "Knowledge end-to-end tests require explicit synthetic fixtures"
    );
  }
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.port !== expectedPort ||
    parsed.pathname !== "/knowledge_test" ||
    parsed.username !== "supabase_admin"
  ) {
    throw new Error(
      "Knowledge end-to-end tests refuse a non-disposable database URL"
    );
  }
  const inspection = JSON.parse(
    execFileSync("docker", ["inspect", container], { encoding: "utf8" })
  ) as Array<{
    Config?: { Labels?: Record<string, string> };
    NetworkSettings?: {
      Ports?: Record<
        string,
        Array<{ HostIp?: string; HostPort?: string }> | null
      >;
    };
  }>;
  const fixture = inspection[0];
  if (
    fixture?.Config?.Labels?.["knowledge.disposable"] !== "true" ||
    !fixture.NetworkSettings?.Ports?.["5432/tcp"]?.some(
      (port) =>
        port.HostPort === expectedPort &&
        ["127.0.0.1", "::1"].includes(port.HostIp ?? "")
    )
  ) {
    throw new Error(
      "Knowledge end-to-end tests require the labelled loopback fixture"
    );
  }
}

async function requireHealthy(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Local fixture is unhealthy: ${url}`);
}

/** Loads and hydrates both portal routes once, before any spec runs.
 *
 * The browser fixture is a Vite dev server, so the FIRST client load of a
 * route is also when its packages are discovered and pre-bundled — and the
 * optimizer's re-bundle invalidates `node_modules/.vite/deps` underneath the
 * imports already in flight, which can leave that first page permanently
 * server-rendered. Paying it here means no spec is the one that pays it, and
 * a portal that cannot hydrate at all says so once, before six specs fail
 * for six different-looking reasons. */
async function warmPortalRoutes(baseUrl: string) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([
      {
        name: "knowledge_e2e_actor",
        value: "bob",
        domain: new URL(baseUrl).hostname,
        path: "/",
        secure: true,
        sameSite: "Lax"
      }
    ]);
    const page = await context.newPage();
    for (const route of ["/", "/intake"]) {
      await page.goto(new URL(route, baseUrl).href);
      await waitForClientNavigation(page);
    }
  } finally {
    await browser.close();
  }
}

export default async function requireLocalSyntheticFixtures() {
  const baseUrl = loopbackTestOrigin(
    "KNOWLEDGE_E2E_BASE_URL",
    "https://localhost:4200",
    "https:"
  );
  const gatewayUrl = loopbackTestOrigin(
    "KNOWLEDGE_E2E_GATEWAY_URL",
    "http://127.0.0.1:4301",
    "http:"
  );
  const queryUrl = loopbackTestOrigin(
    "KNOWLEDGE_E2E_QUERY_FIXTURE_URL",
    "http://127.0.0.1:4302",
    "http:"
  );
  assertDisposableFixture();
  await Promise.all([
    requireHealthy(new URL("/health", gatewayUrl).href),
    requireHealthy(new URL("/health", queryUrl).href)
  ]);
  await warmPortalRoutes(baseUrl);
}
