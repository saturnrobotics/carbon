import { beforeEach, describe, expect, it, vi } from "vitest";
import { parserInvocation, runParserJob, textParserOutput } from "./parser-job";

const SHA256 =
  "3b1f2c9d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c";
/** What `captureRequest` writes: the key is the content hash, nothing else. */
const OBJECT_KEY = `intake/company_synthetic/usr_alex/${SHA256}`;

const readImmutableObject = vi.fn();
const captureImmutableUpload = vi.fn();

vi.mock("./gcs", () => ({
  readImmutableObject: (...args: unknown[]) => readImmutableObject(...args),
  captureImmutableUpload: (...args: unknown[]) =>
    captureImmutableUpload(...args)
}));

/** Runs the job over synthetic text and returns the extraction it wrote. */
async function runOver(
  text: string,
  input: Record<string, unknown> = {}
): Promise<{ fields: Record<string, unknown>; unresolved: string[] }> {
  readImmutableObject.mockResolvedValue(Buffer.from(text, "utf8"));
  captureImmutableUpload.mockResolvedValue(undefined);
  await runParserJob({
    KNOWLEDGE_PARSER_INPUT_JSON: JSON.stringify({
      bucket: "knowledge-objects",
      objectKey: OBJECT_KEY,
      generation: "1",
      sha256: SHA256,
      mimeType: "text/plain",
      ...input
    }),
    KNOWLEDGE_PARSER_OUTPUT_JSON: JSON.stringify({
      bucket: "knowledge-objects",
      objectKey: `parser/${SHA256}/extraction-v1.json`
    })
  });
  const written = captureImmutableUpload.mock.calls.at(-1)?.[0] as {
    bytes: Buffer;
  };
  return JSON.parse(written.bytes.toString("utf8"));
}

beforeEach(() => {
  readImmutableObject.mockReset();
  captureImmutableUpload.mockReset();
});

describe("isolated parser job", () => {
  it("uses fixed local PDF and image parser binaries without runtime credentials", () => {
    expect(parserInvocation("application/pdf")).toEqual({
      command: "/usr/bin/pdftotext",
      args: ["-layout", "-", "-"]
    });
    expect(parserInvocation("image/png")).toEqual({
      command: "/usr/bin/tesseract",
      args: ["stdin", "stdout"]
    });
    expect(() => parserInvocation("application/zip")).toThrow("unsupported");
  });

  it("turns page-delimited text into bounded citable evidence", () => {
    const parsed = textParserOutput("First page\fSecond page", {
      name: "manual.pdf"
    });
    expect(parsed.fields.title).toBe("manual");
    expect(parsed.evidence.body).toEqual([
      { page: 1, text: "First page" },
      { page: 2, text: "Second page" }
    ]);
  });

  it("proposes no title when nothing names the document", () => {
    const parsed = textParserOutput("12 34\f56 78");
    expect(parsed.fields).toEqual({});
    expect(parsed.evidence.title).toBeUndefined();
  });

  it("cites the page a title was read from", () => {
    const parsed = textParserOutput("Bench Press Manual\nModel 1200");
    expect(parsed.fields.title).toBe("Bench Press Manual");
    expect(parsed.evidence.title).toEqual([
      { page: 1, text: "Bench Press Manual" }
    ]);
  });
});

describe("the title the job proposes", () => {
  it("is never the content-addressed object key", async () => {
    const extraction = await runOver("Bench Press Manual\nModel 1200", {
      name: "saturn-bench-press-manual.pdf"
    });
    expect(extraction.fields.title).toBe("saturn-bench-press-manual");
    expect(String(extraction.fields.title)).not.toMatch(/[0-9a-f]{32,}/i);
    expect(String(extraction.fields.title)).not.toContain(SHA256);
  });

  it("is absent rather than a hash when the capture has no name", async () => {
    const extraction = await runOver("4815 162342\n0000 1111");
    expect(extraction.fields).toEqual({});
    expect(JSON.stringify(extraction.fields)).not.toContain(SHA256);
  });

  it("reads the document's own first page when the capture has no name", async () => {
    const extraction = await runOver("Hydraulic Press Manual\nRevision B");
    expect(extraction.fields.title).toBe("Hydraulic Press Manual");
    expect(extraction.unresolved).not.toContain("title");
  });

  it("asks the reviewer to confirm a title the document does not carry", async () => {
    const extraction = await runOver("4815 162342", {
      name: "pump-manual.pdf"
    });
    expect(extraction.fields.title).toBe("pump-manual");
    expect(extraction.unresolved).toContain("title");
  });
});
