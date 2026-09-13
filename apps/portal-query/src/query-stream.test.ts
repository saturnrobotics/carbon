import {
  createLineSplitter,
  decodeQueryStreamLine,
  QUERY_STREAM_MEDIA_TYPE,
  type QueryStreamEvent
} from "@carbon/portal/query/stream";
import { describe, expect, it } from "vitest";
import { respondWithQuery, streamErrorCode } from "./query.server";

const evidence = {
  id: "chunk-a",
  sourceId: "source-a",
  sourceRevision: "1",
  title: "Manual",
  sourceUri: "https://portal.example/documents/doc-a/versions/v1",
  observedAt: "2026-09-01T00:00:00Z",
  policyVersion: "1",
  freshness: "current" as const,
  excerpt: "Connect terminals A and B."
};
const result = {
  requestId: "r1",
  kind: "results" as const,
  evidence: [evidence],
  claims: [],
  message: "",
  partial: false
};

async function events(response: Response): Promise<QueryStreamEvent[]> {
  const reader = response.body!.pipeThrough(createLineSplitter()).getReader();
  const seen: QueryStreamEvent[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const event = decodeQueryStreamLine(next.value);
    if (event) seen.push(event);
  }
  return seen;
}

describe("streamed query delivery", () => {
  it("delivers the events as they happen and ends with the same result JSON would carry", async () => {
    const response = await respondWithQuery(true, async (emit) => {
      emit({ type: "progress", stage: "retrieval", state: "started" });
      emit({ type: "evidence", evidence: [evidence] });
      return result;
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(QUERY_STREAM_MEDIA_TYPE);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await events(response)).toEqual([
      { type: "progress", stage: "retrieval", state: "started" },
      { type: "evidence", evidence: [evidence] },
      { type: "result", result }
    ]);
    const json = await respondWithQuery(false, async (emit) => {
      emit({ type: "evidence", evidence: [evidence] });
      return result;
    });
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.json()).toEqual(result);
  });
  it("turns a failure after the first event into a coded error event, never a message", async () => {
    const response = await respondWithQuery(true, async (emit) => {
      emit({ type: "evidence", evidence: [evidence] });
      throw new Error("Authorization changed: alice lost grant on doc-a");
    });
    const seen = await events(response);
    expect(seen.at(-1)).toEqual({
      type: "error",
      error: "authorization_changed"
    });
    expect(JSON.stringify(seen)).not.toContain("alice lost grant");
  });
  it("maps failures to the three reader-visible codes", () => {
    expect(streamErrorCode(new Error("Access denied"))).toEqual({
      type: "error",
      error: "authorization_changed"
    });
    expect(streamErrorCode(new Error("Query deadline exceeded"))).toEqual({
      type: "error",
      error: "request_deadline_exceeded"
    });
    expect(streamErrorCode(new Error("ECONNREFUSED 10.0.0.1"))).toEqual({
      type: "error",
      error: "query_unavailable"
    });
    expect(streamErrorCode("string")).toEqual({
      type: "error",
      error: "query_unavailable"
    });
  });
});
