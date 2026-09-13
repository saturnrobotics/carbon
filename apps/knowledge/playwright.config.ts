import { defineConfig } from "@playwright/test";
import { assertLoopbackOrigin } from "./tests/loopback";

/** Refuse anything but a loopback target. The PORT is configurable so a second
 * harness can run beside a long-lived one; the HOST never is. */
const baseUrl = assertLoopbackOrigin(
  "KNOWLEDGE_E2E_BASE_URL",
  process.env.KNOWLEDGE_E2E_BASE_URL ?? "https://localhost:4200",
  "https:"
);
const externalBaseUrl = process.env.KNOWLEDGE_E2E_BASE_URL
  ? baseUrl
  : undefined;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/setup.ts",
  // One worker: every spec drives the SAME synthetic company and the same two
  // fixture users, and the gateway's test endpoints mutate them globally —
  // `/__e2e/grant/bob/{review,admin}` swaps the publisher's library grant,
  // `/__e2e/revoke/bob` deactivates the user, and `/__e2e/cleanup` deletes
  // every intake captured since the fixture started. Run in parallel, one
  // spec's authorization experiment is another spec's unexplained denial.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    // Playwright leaves both of these unlimited by default, so one action that
    // can never succeed — a click on a button that stays disabled, a redirect
    // that never comes — spends the entire test timeout and reports itself as
    // whatever the cleanup block failed on afterwards. Bounded, the failure
    // names the locator it was waiting for, well inside the test budget.
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: "retain-on-failure"
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "corepack pnpm tsx tests/harness/start-e2e.ts",
        url: baseUrl,
        env: {
          ...process.env,
          KNOWLEDGE_E2E_SYNTHETIC_FIXTURES: "1",
          // `drive-source.spec.ts` exercises a surface the approved manual-v1
          // release profile defers, so the harness opts the build-time route
          // gate in explicitly. No release image or release plan sets this.
          KNOWLEDGE_DRIVE_ENABLED: "true",
          KNOWLEDGE_COMPANY_ID: "company-b",
          KNOWLEDGE_E2E_PORTAL_PORT: String(new URL(baseUrl).port || 443),
          KNOWLEDGE_WEB_ORIGIN: new URL(baseUrl).origin,
          KNOWLEDGE_WORKER_URL:
            process.env.KNOWLEDGE_E2E_GATEWAY_URL ?? "http://127.0.0.1:4301",
          KNOWLEDGE_WORKER_AUDIENCE: "e2e-worker",
          KNOWLEDGE_QUERY_URL:
            process.env.KNOWLEDGE_E2E_QUERY_FIXTURE_URL ??
            "http://127.0.0.1:4302",
          KNOWLEDGE_QUERY_AUDIENCE: "e2e-query",
          KNOWLEDGE_MANUAL_SOURCE_JSON:
            '{"sourceId":"source-b","displayName":"Operations manuals"}'
        },
        ignoreHTTPSErrors: true,
        reuseExistingServer: false,
        timeout: 120_000
      }
});
