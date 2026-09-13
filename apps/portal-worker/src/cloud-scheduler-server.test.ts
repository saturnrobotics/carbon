import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  dependencies: {
    ingestPool: {},
    bucket: "synthetic-bucket",
    automationUserId: "synthetic-automation",
    manualSource: { sourceId: "manual", displayName: "Manual" },
    machineConfiguration: {
      callers: [
        {
          callerId: "worker",
          companyIds: ["company"],
          sourceIds: ["manual"],
          capabilities: ["source.index.read"]
        }
      ]
    }
  }
}));
vi.mock("./server", () => ({
  configuredWorkerDependencies: () => fixture.dependencies,
  createWorkerHandler: () => async () =>
    Response.json({ error: "not_found" }, { status: 404 })
}));

import { startServer } from "./index";

const environment = {
  PORTAL_RELEASE_PROFILE: "manual-v1",
  PORTAL_DATABASE_METRIC_TYPE:
    "custom.googleapis.com/portal/database_connection_utilization",
  PORTAL_SCHEDULER_MODE: "cloud-scheduler",
  PORTAL_SCHEDULER_AUDIENCE: "https://ingest.example.com",
  PORTAL_SCHEDULER_SUBJECT: "123456789012345678901",
  PORTAL_PARSER_PROJECT: "synthetic-project",
  PORTAL_PARSER_LOCATION: "us-central1",
  PORTAL_PARSER_JOB: "portal-parser",
  PORTAL_PARSER_OUTPUT_BUCKET: "synthetic-parser"
};
let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  server = undefined;
  delete (fixture.dependencies as { sendOutboxEvent?: unknown })
    .sendOutboxEvent;
});
async function boot(overrides: Record<string, string> = {}) {
  server = startServer(0, { ...environment, ...overrides });
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing listener");
  return `http://127.0.0.1:${address.port}`;
}
it("boots manual scheduler mode without an Inngest key and does not install an event sender", async () => {
  const base = await boot();
  const response = await fetch(`${base}/health`);
  expect(response.status).toBe(200);
  expect(fixture.dependencies).not.toHaveProperty("sendOutboxEvent");
});
it("rejects unauthenticated scheduler calls before reaching a database", async () => {
  const base = await boot();
  for (const path of ["check", "drain"]) {
    const response = await fetch(`${base}/internal/outbox/${path}`, {
      method: "POST"
    });
    expect(response.status).toBe(401);
  }
});
it("does not expose Inngest registration in cloud scheduler mode", async () => {
  const base = await boot({ INNGEST_SIGNING_KEY: "signkey-test-synthetic" });
  expect((await fetch(`${base}/api/inngest`)).status).toBe(404);
});
it("refuses an unknown scheduler mode instead of falling back to Inngest", () => {
  expect(() =>
    startServer(0, { ...environment, PORTAL_SCHEDULER_MODE: "misspelled" })
  ).toThrow("scheduler");
});
