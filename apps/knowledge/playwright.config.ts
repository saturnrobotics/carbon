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
  // Every spec shares one disposable database and one set of fixture actors,
  // and the manual-workflow spec deactivates the shared reader mid-run. Files
  // must not overlap, so the whole suite runs in a single worker.
  workers: 1,
  use: {
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
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
          KNOWLEDGE_COMPANY_ID: "company-b",
          KNOWLEDGE_E2E_PORT: String(new URL(baseUrl).port || 443),
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
