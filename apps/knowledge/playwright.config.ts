import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.KNOWLEDGE_E2E_BASE_URL;
if (
  externalBaseUrl &&
  new URL(externalBaseUrl).href !== "https://localhost:4200/"
)
  throw new Error("KNOWLEDGE_E2E_BASE_URL must be the fixed local test origin");

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/setup.ts",
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
