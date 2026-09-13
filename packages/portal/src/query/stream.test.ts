import { describe, expect, it } from "vitest";
import {
  acceptsQueryStream,
  createLineSplitter,
  decodeQueryStreamLine,
  encodeQueryStreamEvent,
  type QueryStreamEvent
} from "./stream";

const evidence = {
  id: "chunk-a",
  sourceId: "source-a",
  sourceRevision: "1",
  title: "Manual",
  sourceUri: "https://portal.example/documents/doc-a/versions/v1#page=3",
  observedAt: "2026-09-01T00:00:00Z",
  policyVersion: "1",
  freshness: "current" as const,
  excerpt: "Torque the terminal screws to 2 Nm.",
  page: 3
};

describe("query stream events", () => {
  it("round-trips every event kind through one NDJSON line", () => {
    const events: QueryStreamEvent[] = [
      { type: "progress", stage: "retrieval", state: "started" },
      { type: "evidence", evidence: [evidence] },
      {
        type: "result",
        result: {
          requestId: "r1",
          kind: "results",
          evidence: [evidence],
          claims: [],
          message: "",
          partial: false
        }
      },
      { type: "error", error: "authorization_changed" }
    ];
    for (const event of events) {
      const line = encodeQueryStreamEvent(event);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      expect(decodeQueryStreamLine(line)).toEqual(event);
    }
    expect(decodeQueryStreamLine("   \n")).toBeNull();
  });
  it("rejects events outside the contract instead of passing them on", () => {
    expect(() =>
      decodeQueryStreamLine(JSON.stringify({ type: "thinking", text: "hmm" }))
    ).toThrow();
    expect(() =>
      decodeQueryStreamLine(JSON.stringify({ type: "error", error: "stack" }))
    ).toThrow();
    expect(() =>
      encodeQueryStreamEvent({
        type: "progress",
        stage: "retrieval",
        state: "thinking"
      } as unknown as QueryStreamEvent)
    ).toThrow();
  });
  it("splits bytes into lines across chunk boundaries and flushes the tail", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n{"b":'));
        controller.enqueue(encoder.encode("2}\n\n"));
        controller.enqueue(encoder.encode('{"c":3}'));
        controller.close();
      }
    });
    const lines: string[] = [];
    const reader = source.pipeThrough(createLineSplitter()).getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      lines.push(next.value);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "", '{"c":3}']);
  });
  it("recognises the stream media type only in an accept header", () => {
    const request = (accept?: string) =>
      new Request("https://query.example/v1/query", {
        headers: accept ? { accept } : {}
      });
    expect(acceptsQueryStream(request("application/x-ndjson"))).toBe(true);
    expect(
      acceptsQueryStream(
        request("application/x-ndjson;q=0.9, application/json")
      )
    ).toBe(true);
    expect(acceptsQueryStream(request("application/json"))).toBe(false);
    expect(acceptsQueryStream(request())).toBe(false);
  });
});
