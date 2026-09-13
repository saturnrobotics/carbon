import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ["app/**/*.test.ts", "app/**/*.test.tsx", "test/**/*.test.ts"],
    passWithNoTests: true,
    // No-op unless one of the outbox suites' database URLs is set. When it is,
    // it attaches the knowledge source-table triggers that
    // 20260913060708_knowledge-source-outbox-triggers-off.sql detaches, for
    // the length of the run only — see the file for why this cannot be a
    // per-suite beforeAll.
    globalSetup: ["./test/setup/knowledge-source-outbox-triggers.ts"],
    // @carbon/env throws at import time when these are unset; tests that
    // transitively import a module barrel (e.g. modules/shared) hit it.
    // Stub values that satisfy "is set" without enabling any side-effects.
    env: {
      INNGEST_SIGNING_KEY: "test",
      INNGEST_EVENT_KEY: "test",
      SUPABASE_URL: "http://localhost",
      SUPABASE_ANON_KEY: "test",
      SUPABASE_SERVICE_ROLE_KEY: "test",
      SUPABASE_API_URL: "http://localhost",
      SUPABASE_DB_URL: "postgresql://localhost",
      SESSION_SECRET: "test",
      REDIS_URL: "redis://localhost"
    }
  }
});
