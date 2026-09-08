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

describe("knowledge worker runtime", () => {
  it("boots the manual runtime without an embedding provider and requires signed events", async () => {
    const audience = "https://worker.example.com";
    const server = startServer(0, {
      KNOWLEDGE_REVIEW_DATABASE_URL:
        "postgresql://review:synthetic@localhost:59910/knowledge_test",
      KNOWLEDGE_READ_DATABASE_URL:
        "postgresql://read:synthetic@localhost:59910/knowledge_test",
      KNOWLEDGE_INGEST_DATABASE_URL:
        "postgresql://ingest:synthetic@localhost:59910/knowledge_test",
      KNOWLEDGE_OBJECT_BUCKET: "synthetic-private",
      KNOWLEDGE_IDENTITY_URL: "https://identity.example.com/v1/identity",
      KNOWLEDGE_IDENTITY_AUDIENCE: "https://identity.example.com",
      KNOWLEDGE_AUTOMATION_USER_ID: "automation",
      KNOWLEDGE_PARSER_PROJECT: "synthetic-project",
      KNOWLEDGE_PARSER_LOCATION: "us-central1",
      KNOWLEDGE_PARSER_JOB: "knowledge-parser",
      KNOWLEDGE_PARSER_OUTPUT_BUCKET: "synthetic-parser-output",
      KNOWLEDGE_MANUAL_SOURCE_JSON: JSON.stringify({
        sourceId: "source",
        displayName: "Manual library"
      }),
      KNOWLEDGE_TRUSTED_CALLERS_JSON: JSON.stringify({
        version: 1,
        receiver: { id: "worker", audience },
        callers: [
          {
            callerId: "portal",
            serviceAccountSubject: "portal@example.iam.gserviceaccount.com",
            sourceIapAudience: "/projects/1/global/backendServices/1",
            operations: ["knowledge.intake.capture"],
            capabilities: [],
            requiredAccessLevels: []
          }
        ]
      }),
      KNOWLEDGE_MACHINE_CALLERS_JSON: JSON.stringify({
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
