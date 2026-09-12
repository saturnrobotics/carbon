import { defineConfig } from "@playwright/test";
import { loopbackTestOrigin } from "./tests/setup";

const externalBaseUrl = process.env.KNOWLEDGE_E2E_BASE_URL;
// Only the scheme and the loopback host are fixed; the port follows whichever
// synthetic stack published the portal (see tests/setup.ts).
if (externalBaseUrl)
  loopbackTestOrigin("KNOWLEDGE_E2E_BASE_URL", externalBaseUrl, "https:");

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
  use: {
    baseURL: externalBaseUrl ?? "https://localhost:4200",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure"
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "corepack pnpm tsx tests/harness/start-e2e.ts",
        url: "https://localhost:4200/",
        env: {
          ...process.env,
          KNOWLEDGE_E2E_SYNTHETIC_FIXTURES: "1",
          KNOWLEDGE_COMPANY_ID: "company-b",
          KNOWLEDGE_WEB_ORIGIN: "https://localhost:4200",
          KNOWLEDGE_WORKER_URL: "http://127.0.0.1:4301",
          KNOWLEDGE_WORKER_AUDIENCE: "e2e-worker",
          KNOWLEDGE_QUERY_URL: "http://127.0.0.1:4302",
          KNOWLEDGE_QUERY_AUDIENCE: "e2e-query",
          KNOWLEDGE_MANUAL_SOURCE_JSON:
            '{"sourceId":"source-b","displayName":"Operations manuals"}'
        },
        ignoreHTTPSErrors: true,
        reuseExistingServer: false,
        timeout: 120_000
      }
});
