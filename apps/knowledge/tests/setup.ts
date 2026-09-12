import { execFileSync } from "node:child_process";
import { assertLoopbackOrigin } from "./loopback";

const container =
  process.env.KNOWLEDGE_E2E_DATABASE_CONTAINER ?? "knowledge-schema-test";
const expectedPort = process.env.KNOWLEDGE_E2E_DATABASE_PORT ?? "59910";

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

export default async function requireLocalSyntheticFixtures() {
  assertLoopbackOrigin(
    "KNOWLEDGE_E2E_BASE_URL",
    process.env.KNOWLEDGE_E2E_BASE_URL ?? "https://localhost:4200",
    "https:"
  );
  const gatewayUrl = assertLoopbackOrigin(
    "KNOWLEDGE_E2E_GATEWAY_URL",
    process.env.KNOWLEDGE_E2E_GATEWAY_URL ?? "http://127.0.0.1:4301",
    "http:"
  );
  const queryUrl = assertLoopbackOrigin(
    "KNOWLEDGE_E2E_QUERY_FIXTURE_URL",
    process.env.KNOWLEDGE_E2E_QUERY_FIXTURE_URL ?? "http://127.0.0.1:4302",
    "http:"
  );
  assertDisposableFixture();
  await Promise.all([
    requireHealthy(new URL("/health", gatewayUrl).href),
    requireHealthy(new URL("/health", queryUrl).href)
  ]);
}
