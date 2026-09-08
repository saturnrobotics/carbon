import { expect, it } from "vitest";
import { requestBoundary } from "./request-boundary.server";

it("uses private request correlation and redacts errors on the actual HTTP boundary", async () => {
  const logs: unknown[] = [];
  const handle = requestBoundary(
    "query",
    async () => {
      throw Error("token=secret");
    },
    { sink: (record) => logs.push(record) }
  );
  const response = await handle(
    new Request("https://example.com/v1/query?private=content", {
      headers: { "x-request-id": "user@example.com" }
    })
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(logs) + (await response.text())).not.toMatch(
    /secret|user@|private|content/
  );
});
it("bounds HTTP completion when handlers ignore signals", async () => {
  const response = await requestBoundary("query", () => new Promise(() => {}), {
    milliseconds: 10,
    sink: () => {}
  })(new Request("https://example.com"));
  expect(response.status).toBe(504);
});
