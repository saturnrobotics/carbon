import { spawn } from "node:child_process";
import { createServer } from "node:http";

const maximumRequestBytes = 32_768;
const parserJob =
  process.env.KNOWLEDGE_PARSER_JOB_PATH ?? "/app/dist/parser-job.js";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function parseRequest(bytes) {
  const request = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(request) || !isRecord(request.input) || !isRecord(request.output))
    throw new Error("invalid parser request");
  const { input, output } = request;
  if (
    !boundedString(input.bucket, 222) ||
    !boundedString(input.objectKey, 1_024) ||
    !boundedString(input.generation, 256) ||
    !/^[a-f0-9]{64}$/.test(input.sha256 ?? "") ||
    !boundedString(input.mimeType, 128) ||
    (input.maxBytes !== undefined &&
      (!Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.maxBytes > 50_000_000)) ||
    !boundedString(output.bucket, 222) ||
    !boundedString(output.objectKey, 1_024)
  )
    throw new Error("invalid parser request");
  return { input, output };
}

function runParser(request) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [parserJob], {
      env: {
        ...process.env,
        KNOWLEDGE_PARSER_INPUT_JSON: JSON.stringify(request.input),
        KNOWLEDGE_PARSER_OUTPUT_JSON: JSON.stringify(request.output)
      },
      stdio: ["ignore", "inherit", "inherit"]
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 130_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const server = createServer(async (incoming, outgoing) => {
  outgoing.setHeader("cache-control", "no-store");
  outgoing.setHeader("content-type", "application/json; charset=utf-8");
  const pathname = new URL(
    incoming.url ?? "/",
    `http://${incoming.headers.host ?? "parser.internal"}`
  ).pathname;
  if (incoming.method === "GET" && pathname === "/health") {
    outgoing.writeHead(200).end('{"status":"ok","service":"knowledge-parser"}');
    return;
  }
  if (pathname !== "/parse") {
    outgoing.writeHead(404).end('{"error":"not_found"}');
    return;
  }
  if (incoming.method !== "POST") {
    outgoing.writeHead(405).end('{"error":"method_not_allowed"}');
    return;
  }
  const declared = Number(incoming.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declared) || declared > maximumRequestBytes) {
    outgoing.writeHead(413).end('{"error":"request_too_large"}');
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumRequestBytes) {
      outgoing.writeHead(413).end('{"error":"request_too_large"}');
      return;
    }
    chunks.push(bytes);
  }
  let request;
  try {
    request = parseRequest(Buffer.concat(chunks));
  } catch {
    outgoing.writeHead(400).end('{"error":"invalid_request"}');
    return;
  }
  if (!(await runParser(request))) {
    outgoing.writeHead(502).end('{"error":"parser_failed"}');
    return;
  }
  outgoing.removeHeader("content-type");
  outgoing.writeHead(204).end();
});

server.requestTimeout = 140_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");
