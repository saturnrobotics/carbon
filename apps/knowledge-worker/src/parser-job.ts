import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createExtraction, type ParserOutput } from "@carbon/knowledge/intake";
import {
  captureImmutableUpload,
  type ImmutableObjectReference,
  readImmutableObject
} from "./gcs";
import { manualMimeTypes } from "./manual-file";

type JobInput = ImmutableObjectReference & { mimeType: string };
type JobOutput = { bucket: string; objectKey: string };

function parseEnvironment(environment: NodeJS.ProcessEnv): {
  input: JobInput;
  output: JobOutput;
} {
  const input = JSON.parse(
    environment.KNOWLEDGE_PARSER_INPUT_JSON ?? "null"
  ) as JobInput | null;
  const output = JSON.parse(
    environment.KNOWLEDGE_PARSER_OUTPUT_JSON ?? "null"
  ) as JobOutput | null;
  if (
    !input?.bucket ||
    !input.objectKey ||
    !input.generation ||
    !input.sha256 ||
    !input.mimeType ||
    !output?.bucket ||
    !output.objectKey
  )
    throw new Error("immutable parser job references are required");
  return { input, output };
}

export function parserInvocation(mimeType: string): {
  command: string;
  args: string[];
} {
  if (mimeType === "application/pdf")
    return { command: "/usr/bin/pdftotext", args: ["-layout", "-", "-"] };
  if (manualMimeTypes.has(mimeType))
    return { command: "/usr/bin/tesseract", args: ["stdin", "stdout"] };
  throw new Error("unsupported parser input MIME type");
}

export function textParserOutput(text: string, title: string): ParserOutput {
  const evidence: Array<{ page: number; text: string }> = [];
  const pages = text.split("\f").slice(0, 2_000);
  for (const [index, page] of pages.entries()) {
    const normalized = page.trim();
    for (
      let offset = 0;
      offset < normalized.length && evidence.length < 100;
      offset += 8_000
    ) {
      const part = normalized.slice(offset, offset + 8_000).trim();
      if (part) evidence.push({ page: index + 1, text: part });
    }
    if (evidence.length >= 100) break;
  }
  return {
    fields: { title },
    evidence: { body: evidence },
    warnings:
      pages.length < text.split("\f").length || evidence.length >= 100
        ? ["Parser output was truncated to the bounded evidence envelope"]
        : []
  };
}

async function externalParse(
  bytes: Buffer,
  mimeType: string,
  command: string,
  args: readonly string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        KNOWLEDGE_INPUT_MIME: mimeType
      }
    });
    const output: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("parser exceeded its time limit"));
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8_000_000) {
        child.kill("SIGKILL");
        finish(new Error("parser output exceeded its byte limit"));
      } else output.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.stdin.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error("parser process failed"));
      try {
        finish(
          undefined,
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(output)
          )
        );
      } catch {
        finish(new Error("parser returned invalid UTF-8"));
      }
    });
    child.stdin.end(bytes);
  });
}

export async function runParserJob(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const { input, output } = parseEnvironment(environment);
  const bytes = await readImmutableObject({ ...input, maxBytes: 50_000_000 });
  let parsed: ParserOutput;
  if (input.mimeType === "text/plain") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = textParserOutput(
      text,
      input.objectKey.split("/").at(-1) ?? "Document"
    );
  } else {
    const invocation = parserInvocation(input.mimeType);
    const text = await externalParse(
      bytes,
      input.mimeType,
      invocation.command,
      invocation.args
    );
    parsed = textParserOutput(
      text,
      input.objectKey.split("/").at(-1) ?? "Document"
    );
  }
  const extraction = createExtraction(parsed);
  await captureImmutableUpload({
    bucket: output.bucket,
    objectKey: output.objectKey,
    bytes: Buffer.from(JSON.stringify(extraction)),
    mimeType: "application/json",
    maxBytes: 8_000_000
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runParserJob().catch(() => {
    process.exitCode = 1;
  });
