import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./index";

const servers: ReturnType<typeof startServer>[] = [];
afterEach(async () =>
  Promise.all(
    servers
      .splice(0)
      .filter((server) => server.listening)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  )
);

describe("portal worker runtime", () => {
  it("boots the manual runtime without an embedding provider and requires signed events", async () => {
    const audience = "https://worker.example.com";
    const server = startServer(0, {
      PORTAL_REVIEW_DATABASE_URL:
        "postgresql://review:synthetic@localhost:59910/portal_test",
      PORTAL_READ_DATABASE_URL:
        "postgresql://read:synthetic@localhost:59910/portal_test",
      PORTAL_INGEST_DATABASE_URL:
        "postgresql://ingest:synthetic@localhost:59910/portal_test",
      PORTAL_OBJECT_BUCKET: "synthetic-private",
      PORTAL_IDENTITY_URL: "https://identity.example.com/v1/identity",
      PORTAL_IDENTITY_AUDIENCE: "https://identity.example.com",
      PORTAL_AUTOMATION_USER_ID: "automation",
      PORTAL_PARSER_PROJECT: "synthetic-project",
      PORTAL_PARSER_LOCATION: "us-central1",
      PORTAL_PARSER_JOB: "portal-parser",
      PORTAL_PARSER_OUTPUT_BUCKET: "synthetic-parser-output",
      PORTAL_MANUAL_SOURCE_JSON: JSON.stringify({
        sourceId: "source",
        displayName: "Manual library"
      }),
      PORTAL_TRUSTED_CALLERS_JSON: JSON.stringify({
        version: 1,
        receiver: { id: "worker", audience },
        callers: [
          {
            callerId: "portal",
            serviceAccountSubject: "portal@example.iam.gserviceaccount.com",
            sourceIapAudience: "/projects/1/global/backendServices/1",
            operations: ["portal.intake.capture"],
            capabilities: [],
            requiredAccessLevels: []
          }
        ]
      }),
      PORTAL_MACHINE_CALLERS_JSON: JSON.stringify({
        audience,
        callers: [
          {
            subject: "source@example.iam.gserviceaccount.com",
            callerId: "source",
            companyIds: ["company"],
            sourceIds: ["source"],
            capabilities: ["source.index.read"]
          }
        ]
      }),
      INNGEST_SIGNING_KEY: "signkey-test-00000000000000000000000000000000"
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    await expect(
      fetch(`http://127.0.0.1:${port}/health`).then(
        (response) => response.status
      )
    ).resolves.toBe(200);
    await expect(
      fetch(`http://127.0.0.1:${port}/api/inngest`, {
        method: "POST",
        body: "{}"
      }).then((response) => response.status)
    ).resolves.not.toBe(200);
  });
});
