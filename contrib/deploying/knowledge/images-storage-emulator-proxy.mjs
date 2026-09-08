import { createServer, request } from "node:http";

const target = new URL(process.env.KNOWLEDGE_STORAGE_EMULATOR_TARGET ?? "http://storage:4443");

createServer((incoming, outgoing) => {
  const sourcePath = incoming.url ?? "/";
  const path = sourcePath.startsWith("/b")
    ? `/storage/v1${sourcePath}`
    : sourcePath;
  const upstream = request(
    {
      hostname: target.hostname,
      port: target.port,
      method: incoming.method,
      path,
      headers: { ...incoming.headers, host: target.host }
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    }
  );
  upstream.once("error", () => {
    if (!outgoing.headersSent)
      outgoing.writeHead(502, { "content-type": "text/plain" });
    outgoing.end("storage emulator unavailable");
  });
  incoming.pipe(upstream);
}).listen(Number(process.env.PORT ?? "8081"), "0.0.0.0");
