import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { waitForClientNavigation } from "./harness/browser";
import { assertLoopbackOrigin } from "./loopback";

const container =
  process.env.PORTAL_E2E_DATABASE_CONTAINER ?? "portal-schema-test";
const expectedPort = process.env.PORTAL_E2E_DATABASE_PORT ?? "59910";

/** Refuse to run browser tests unless the supplied database is the known labelled
 * disposable fixture. The local services then clean only captured intake IDs. */
function assertDisposableFixture() {
  const url = process.env.PORTAL_E2E_DATABASE_URL;
  if (!url || process.env.PORTAL_E2E_SYNTHETIC_FIXTURES !== "1") {
    throw new Error(
      "Portal end-to-end tests require explicit synthetic fixtures"
    );
  }
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.port !== expectedPort ||
    parsed.pathname !== "/portal_test" ||
    parsed.username !== "supabase_admin"
  ) {
    throw new Error(
      "Portal end-to-end tests refuse a non-disposable database URL"
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
    fixture?.Config?.Labels?.["portal.disposable"] !== "true" ||
    !fixture.NetworkSettings?.Ports?.["5432/tcp"]?.some(
      (port) =>
        port.HostPort === expectedPort &&
        ["127.0.0.1", "::1"].includes(port.HostIp ?? "")
    )
  ) {
    throw new Error(
      "Portal end-to-end tests require the labelled loopback fixture"
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
        name: "portal_e2e_actor",
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
  const baseUrl = assertLoopbackOrigin(
    "PORTAL_E2E_BASE_URL",
    process.env.PORTAL_E2E_BASE_URL ?? "https://localhost:4200",
    "https:"
  );
  const gatewayUrl = assertLoopbackOrigin(
    "PORTAL_E2E_GATEWAY_URL",
    process.env.PORTAL_E2E_GATEWAY_URL ?? "http://127.0.0.1:4301",
    "http:"
  );
  const queryUrl = assertLoopbackOrigin(
    "PORTAL_E2E_QUERY_FIXTURE_URL",
    process.env.PORTAL_E2E_QUERY_FIXTURE_URL ?? "http://127.0.0.1:4302",
    "http:"
  );
  // The Drive connector fixture is a second pair of endpoints: the manual
  // library's query service is pinned to the upload source and can never
  // answer for a Drive one, and its gateway admits no Drive caller.
  const driveGatewayUrl = assertLoopbackOrigin(
    "PORTAL_E2E_DRIVE_GATEWAY_URL",
    process.env.PORTAL_E2E_DRIVE_GATEWAY_URL ?? "http://127.0.0.1:4301",
    "http:"
  );
  const driveQueryUrl = assertLoopbackOrigin(
    "PORTAL_E2E_DRIVE_QUERY_URL",
    process.env.PORTAL_E2E_DRIVE_QUERY_URL ?? "http://127.0.0.1:4302",
    "http:"
  );
  assertDisposableFixture();
  await Promise.all(
    [...new Set([gatewayUrl, queryUrl, driveGatewayUrl, driveQueryUrl])].map(
      (url) => requireHealthy(new URL("/health", url).href)
    )
  );
  await warmPortalRoutes(baseUrl);
}
