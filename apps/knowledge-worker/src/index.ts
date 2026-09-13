import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { outboxBacklog } from "@carbon/knowledge/indexing/outbox.server";
import { createTelemetry } from "@carbon/knowledge/telemetry";
import { serve } from "inngest/node";
import { createBacklogObserver } from "./backlog";
import {
  createCarbonChangeFunction,
  createCarbonReconciliationFunction,
  readCarbonSourceConfiguration
} from "./carbon-changes";
import { createDriveApiClient, downloadDriveDocument } from "./drive-client";
import { createDriveSyncFunction } from "./drive-sync";
import { createOutboxDeliveryFunction } from "./functions";
import { knowledgeInngest } from "./inngest";
import { createOutboxInvalidationFunction } from "./invalidation";
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
  // Drive synchronization exists only when a connector credential broker is
  // configured; the manual-v1 release rejects that configuration outright.
  const driveConfigured =
    !!dependencies &&
    !!environment.KNOWLEDGE_DRIVE_TOKEN_BROKER_URL &&
    !!environment.KNOWLEDGE_DRIVE_TOKEN_BROKER_AUDIENCE;
  const driveSources = driveConfigured
    ? dependencies.machineConfiguration.callers
        .filter((caller) => caller.capabilities.includes("source.changes.read"))
        .flatMap((caller) =>
          caller.companyIds.flatMap((companyId) =>
            caller.sourceIds.map((sourceId) => ({
              companyId,
              sourceId,
              callerId: caller.callerId
            }))
          )
        )
    : [];
  if (dependencies) {
    dependencies.sendOutboxEvent = async (companyId) => {
      await knowledgeInngest.send({
        name: "knowledge/outbox.deliver",
        data: { companyId },
        id: `knowledge-outbox-${companyId}-${crypto.randomUUID()}`
      });
    };
    if (driveSources.length)
      dependencies.requestDriveSync = async (input) => {
        await knowledgeInngest.send({
          name: "knowledge/drive.sync",
          data: input,
          id: `knowledge-drive-${input.sourceId}-${crypto.randomUUID()}`
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
  const carbonSource = dependencies
    ? readCarbonSourceConfiguration(environment)
    : null;
  const carbonRuntime =
    dependencies && carbonSource
      ? {
          pool: dependencies.ingestPool,
          companies: [
            ...new Map(
              dependencies.machineConfiguration.callers
                .filter(
                  (caller) =>
                    caller.capabilities.includes("source.changes.read") &&
                    caller.sourceIds.includes(carbonSource.sourceId)
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
          ],
          workerId: environment.K_REVISION ?? `knowledge-worker-${process.pid}`,
          source: carbonSource,
          automationUserId: dependencies.automationUserId
        }
      : null;
  const functions = dependencies
    ? [
        ...(carbonRuntime
          ? [
              createCarbonChangeFunction(carbonRuntime),
              createCarbonReconciliationFunction(carbonRuntime)
            ]
          : []),
        createOutboxDeliveryFunction({
          pool: dependencies.ingestPool,
          companies: workerCompanies,
          workerId: environment.K_REVISION ?? `knowledge-worker-${process.pid}`,
          sourceId: dependencies.manualSource.sourceId,
          embeddingProfile: "manual-v1",
          observeBacklog: createBacklogObserver({
            telemetry: createTelemetry("worker"),
            backlog: (principal) =>
              outboxBacklog(dependencies.ingestPool, principal)
          }),
          process: (principal, event) =>
            processKnowledgeOutbox(
              {
                pool: dependencies.ingestPool,
                bucket: dependencies.bucket,
                automationUserId: dependencies.automationUserId,
                manualSourceId: dependencies.manualSource.sourceId,
                parseDocument: (reference, mimeType, name) =>
                  invokeCloudRunParserJob(reference, mimeType, {
                    project: parserProject!,
                    location: parserLocation!,
                    job: parserJob!,
                    outputBucket: parserOutputBucket!,
                    ...(name ? { name } : {})
                  }),
                ...(driveSources.length
                  ? {
                      loadDriveDocument: async (sourceId, fileId, mimeType) => {
                        const token =
                          await dependencies.connectorAccessToken(sourceId);
                        if (!token)
                          throw new Error(
                            "Drive connector credential is unavailable"
                          );
                        return downloadDriveDocument(token, fileId, mimeType);
                      }
                    }
                  : {})
              },
              principal,
              event
            )
        }),
        createOutboxInvalidationFunction({
          pool: dependencies.ingestPool,
          companies: workerCompanies,
          workerId: environment.K_REVISION ?? `knowledge-worker-${process.pid}`,
          sourceId: dependencies.manualSource.sourceId
        }),
        ...(driveSources.length
          ? [
              createDriveSyncFunction({
                pool: dependencies.ingestPool,
                sources: driveSources,
                automationUserId: dependencies.automationUserId,
                workerId:
                  environment.K_REVISION ?? `knowledge-worker-${process.pid}`,
                connectorAccessToken: dependencies.connectorAccessToken,
                createClient: (accessToken) => createDriveApiClient(accessToken)
              })
            ]
          : [])
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
