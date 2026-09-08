import { execFileSync } from "node:child_process";
import { startE2eGateway } from "../../knowledge-worker/src/test/e2e-gateway";

const container =
  process.env.KNOWLEDGE_E2E_DATABASE_CONTAINER ?? "knowledge-schema-test";
const expectedPort = "59910";

/** Refuse to run browser tests unless the supplied database is the known labelled
 * disposable fixture. The test gateway then performs only prefix-scoped cleanup. */
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
    parsed.username !== "knowledge_test_migrator"
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
      Ports?: Record<string, Array<{ HostPort?: string }> | null>;
    };
  }>;
  const fixture = inspection[0];
  if (
    fixture?.Config?.Labels?.["knowledge.disposable"] !== "true" ||
    !fixture.NetworkSettings?.Ports?.["5432/tcp"]?.some(
      (port) => port.HostPort === expectedPort
    )
  ) {
    throw new Error(
      "Knowledge end-to-end tests require the labelled loopback fixture"
    );
  }
}

export default async function requireSyntheticStagingFixtures() {
  assertDisposableFixture();
  const gateway = await startE2eGateway(
    process.env.KNOWLEDGE_E2E_DATABASE_URL!
  );
  return async () => gateway.close();
}
