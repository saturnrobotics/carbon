import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { serve } from "inngest/node";
import { createOutboxDeliveryFunction } from "./functions";
import { knowledgeInngest } from "./inngest";
import { invokeCloudRunParserJob } from "./parser";
import { processKnowledgeOutbox } from "./processor";
import { configuredWorkerDependencies, createWorkerHandler } from "./server";

export const serviceName = "knowledge-worker";

export function startServer(
  port = Number(process.env.PORT ?? "8080"),
  environment: NodeJS.ProcessEnv = process.env
) {
  const signingKey = environment.INNGEST_SIGNING_KEY?.trim();
  const configuredDependencies = configuredWorkerDependencies(environment);
  const parserProject = environment.KNOWLEDGE_PARSER_PROJECT;
  const parserLocation = environment.KNOWLEDGE_PARSER_LOCATION;
  const parserJob = environment.KNOWLEDGE_PARSER_JOB;
  const parserOutputBucket = environment.KNOWLEDGE_PARSER_OUTPUT_BUCKET;
  const dependencies =
    signingKey &&
    parserProject &&
    parserLocation &&
    parserJob &&
    parserOutputBucket
      ? configuredDependencies
      : null;
  if (dependencies) {
    dependencies.sendOutboxEvent = async (companyId) => {
      await knowledgeInngest.send({
        name: "knowledge/outbox.deliver",
        data: { companyId },
        id: `knowledge-outbox-${companyId}-${crypto.randomUUID()}`
      });
    };
  }
  const handler = createWorkerHandler(dependencies);
  const workerCompanies = dependencies
    ? [
        ...new Map(
          dependencies.machineConfiguration.callers
            .filter(
              (caller) =>
                caller.capabilities.includes("source.index.read") &&
                caller.sourceIds.includes(dependencies.manualSource.sourceId)
            )
            .flatMap((caller) =>
              caller.companyIds.map(
                (companyId) =>
                  [
                    `${caller.callerId}:${companyId}`,
                    { companyId, callerId: caller.callerId }
                  ] as const
              )
            )
        ).values()
      ]
    : [];
  const functions = dependencies
    ? [
        createOutboxDeliveryFunction({
          pool: dependencies.ingestPool,
          companies: workerCompanies,
          workerId: environment.K_REVISION ?? `knowledge-worker-${process.pid}`,
          sourceId: dependencies.manualSource.sourceId,
          embeddingProfile: "manual-v1",
          process: (principal, event) =>
            processKnowledgeOutbox(
              {
                pool: dependencies.ingestPool,
                bucket: dependencies.bucket,
                automationUserId: dependencies.automationUserId,
                manualSourceId: dependencies.manualSource.sourceId,
                parseDocument: (reference, mimeType) =>
                  invokeCloudRunParserJob(reference, mimeType, {
                    project: parserProject!,
                    location: parserLocation!,
                    job: parserJob!,
                    outputBucket: parserOutputBucket!
                  })
              },
              principal,
              event
            )
        })
      ]
    : [];
  const inngestHandler = serve({
    client: knowledgeInngest,
    functions,
    ...(signingKey ? { signingKey } : {})
  });
  const server = createServer(async (incoming, outgoing) => {
    const pathname = new URL(
      incoming.url ?? "/",
      `http://${incoming.headers.host ?? "worker.internal"}`
    ).pathname;
    if (pathname === "/api/inngest" && dependencies)
      return inngestHandler(incoming, outgoing);
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.setHeader("cache-control", "no-store");
    if (incoming.method === "GET" && pathname === "/health") {
      outgoing.writeHead(dependencies ? 200 : 503).end(
        JSON.stringify({
          status: dependencies ? "ok" : "not-configured",
          service: serviceName
        })
      );
      return;
    }
    try {
      const declared = Number(incoming.headers["content-length"] ?? 0);
      if (declared > 52_000_000) {
        outgoing
          .writeHead(413)
          .end(JSON.stringify({ error: "request_too_large" }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 52_000_000) {
          outgoing
            .writeHead(413)
            .end(JSON.stringify({ error: "request_too_large" }));
          return;
        }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(
        new URL(incoming.url ?? "/", "http://worker.internal"),
        {
          method: incoming.method,
          headers,
          ...(size ? { body: Buffer.concat(chunks) } : {})
        }
      );
      const response = await handler(request);
      response.headers.forEach((value, key) => {
        outgoing.setHeader(key, value);
      });
      outgoing
        .writeHead(response.status)
        .end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing
        .writeHead(503)
        .end(JSON.stringify({ error: "service_unavailable" }));
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  return server.listen(port, "0.0.0.0");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startServer();
