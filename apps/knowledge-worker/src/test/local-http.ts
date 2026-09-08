import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";

export async function handleLocalHttpRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  maximumBytes: number,
  handler: (request: Request) => Promise<Response>
): Promise<void> {
  try {
    const declared = Number(incoming.headers["content-length"] ?? 0);
    if (declared > maximumBytes) {
      outgoing
        .writeHead(413, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "request_too_large" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        outgoing
          .writeHead(413, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "request_too_large" }));
        return;
      }
      chunks.push(bytes);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const response = await handler(
      new Request(
        new URL(
          incoming.url ?? "/",
          `http://${incoming.headers.host ?? "localhost"}`
        ),
        {
          method: incoming.method,
          headers,
          ...(size ? { body: Buffer.concat(chunks) } : {})
        }
      )
    );
    response.headers.forEach((value, key) => {
      outgoing.setHeader(key, value);
    });
    outgoing
      .writeHead(response.status)
      .end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing
      .writeHead(503, {
        "cache-control": "no-store",
        "content-type": "application/json"
      })
      .end(JSON.stringify({ error: "local_fixture_unavailable" }));
  }
}

export function startLocalHttpServer(options: {
  port: number;
  maximumBytes: number;
  handler: (request: Request) => Promise<Response>;
}): Server {
  const server = createServer((incoming, outgoing) =>
    handleLocalHttpRequest(
      incoming,
      outgoing,
      options.maximumBytes,
      options.handler
    )
  );
  server.requestTimeout = 310_000;
  server.headersTimeout = 10_000;
  return server.listen(options.port, "0.0.0.0");
}
