import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeCloudRunParserJob, invokeIsolatedParser } from "./parser";

describe("invokeIsolatedParser", () => {
  it("passes only immutable object references to the credential-isolated parser", async () => {
    const parserBytes = Buffer.from(
      JSON.stringify({
        fields: { title: "Manual" },
        evidence: { title: [{ page: 1, text: "Manual" }] }
      })
    );
    const requests: Array<{ headers: Headers; body: string }> = [];
    const storage = {
      bucket: () => ({
        file: (_key: string, options: { generation: string }) => ({
          getMetadata: async () => [
            { size: String(parserBytes.length), generation: options.generation }
          ],
          download: async () => [parserBytes]
        })
      })
    };
    const output = await invokeIsolatedParser(
      {
        bucket: "private",
        objectKey: "intake/manual",
        generation: "42",
        sha256: "a".repeat(64)
      },
      "application/pdf",
      {
        parserUrl: "https://parser.example.com/v1/parse",
        authorizationHeader: async () => "Bearer fresh-service-token",
        storage: storage as never,
        fetchImpl: async (_url, init) => {
          requests.push({
            headers: new Headers(init?.headers),
            body: String(init?.body)
          });
          return Response.json({
            output: {
              bucket: "private",
              objectKey: "parser/out",
              generation: "7",
              sha256: createHash("sha256").update(parserBytes).digest("hex")
            }
          });
        }
      }
    );
    expect(output.fields.title).toBe("Manual");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer fresh-service-token"
    );
    expect(requests[0]?.body).not.toContain("fresh-service-token");
  });
});

it("invokes a finite Cloud Run parser job with immutable references and reads its pinned output", async () => {
  const parserBytes = Buffer.from(
    JSON.stringify({
      fields: { title: "Manual" },
      evidence: { title: [{ page: 1, text: "Manual" }] }
    })
  );
  const storage = {
    bucket: () => ({
      file: (_key: string, options?: { generation?: string }) => ({
        getMetadata: async () => [
          {
            size: String(parserBytes.length),
            generation: options?.generation ?? "9"
          }
        ],
        download: async () => [parserBytes]
      })
    })
  };
  let requestBody = "";
  const output = await invokeCloudRunParserJob(
    {
      bucket: "input",
      objectKey: "manual.pdf",
      generation: "42",
      sha256: "a".repeat(64)
    },
    "application/pdf",
    {
      project: "synthetic-project",
      location: "us-central1",
      job: "knowledge-parser",
      outputBucket: "output",
      storage: storage as never,
      accessToken: async () => "cloud-platform-token",
      fetchImpl: async (_url, init) => {
        requestBody = String(init?.body);
        return Response.json({ name: "operations/parser", done: true });
      }
    }
  );
  expect(output.fields.title).toBe("Manual");
  const runRequest = JSON.parse(requestBody) as {
    overrides: {
      containerOverrides: Array<{
        env: Array<{ name: string; value: string }>;
      }>;
    };
  };
  const input = runRequest.overrides.containerOverrides[0]?.env.find(
    (entry) => entry.name === "KNOWLEDGE_PARSER_INPUT_JSON"
  );
  expect(JSON.parse(input?.value ?? "null")).toMatchObject({
    generation: "42"
  });
  expect(requestBody).not.toContain("cloud-platform-token");
});
