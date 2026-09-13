import { z } from "zod";
import { evidenceSchema } from "../contracts";
import { QUERY_BUDGETS } from "./budgets";
import { queryResultSchema } from "./result";

/**
 * The events an interactive read streams to the reader, newline-delimited
 * JSON. Every event is something that actually happened: evidence is sent
 * the moment it is authorized, a progress event names a stage that has
 * really started or a source that really did not answer, and the terminal
 * `result` is the same value a non-streaming call returns. There is no
 * placeholder or generated "thinking" text.
 */
export const QUERY_STREAM_MEDIA_TYPE = "application/x-ndjson";

export const queryStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      stage: z.enum(["retrieval", "sources", "synthesis"]),
      /** `partial`: a permitted source did not answer; `started` otherwise. */
      state: z.enum(["started", "partial"])
    })
    .strict(),
  z
    .object({
      type: z.literal("evidence"),
      evidence: z.array(evidenceSchema).max(QUERY_BUDGETS.evidenceBlocks)
    })
    .strict(),
  z.object({ type: z.literal("result"), result: queryResultSchema }).strict(),
  z
    .object({
      type: z.literal("error"),
      error: z.enum([
        "query_unavailable",
        "authorization_changed",
        "request_deadline_exceeded"
      ])
    })
    .strict()
]);
export type QueryStreamEvent = z.infer<typeof queryStreamEventSchema>;

export function acceptsQueryStream(request: Request): boolean {
  return (
    request.headers
      .get("accept")
      ?.split(",")
      .some((part) => part.trim().split(";")[0] === QUERY_STREAM_MEDIA_TYPE) ??
    false
  );
}

export function encodeQueryStreamEvent(event: QueryStreamEvent): string {
  return `${JSON.stringify(queryStreamEventSchema.parse(event))}\n`;
}

/** Parses one NDJSON line; an empty line yields `null`, anything else must validate. */
export function decodeQueryStreamLine(line: string): QueryStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return queryStreamEventSchema.parse(JSON.parse(trimmed));
}

/** Splits a byte stream into complete lines; the remainder is kept until more arrives. */
export function createLineSplitter(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder();
  let pending = "";
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let index = pending.indexOf("\n");
      while (index !== -1) {
        controller.enqueue(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }
      if (pending.length > 262144)
        throw new Error("Query stream line limit exceeded");
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.trim()) controller.enqueue(pending);
    }
  });
}
