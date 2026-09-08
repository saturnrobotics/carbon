/**
 * Docker-only manual workflow fixture. It substitutes signed Google assertions
 * at the outer verification boundary, while using the production worker,
 * canonical identity resolver, role-scoped transactions, immutable object
 * storage, outbox leasing, processor, and parser result contract.
 */

import { createServer } from "node:http";
import { verifyWorkforceRequest } from "@carbon/knowledge/identity.server";
import { postgresIdentityStore } from "@carbon/knowledge/identity-store.server";
import { createExtraction, type ParserOutput } from "@carbon/knowledge/intake";
import { Storage } from "@google-cloud/storage";
import { serve } from "inngest/node";
import { Pool } from "pg";
import { createOutboxDeliveryFunction } from "../functions";
import {
  captureExistingObject,
  type ImmutableObjectReference,
  readImmutableObject
} from "../gcs";
import { knowledgeInngest } from "../inngest";
import { processKnowledgeOutbox } from "../processor";
import { createWorkerHandler, type WorkerDependencies } from "../server";
import {
  cleanCapturedIntakes,
  localBucket,
  localCallerConfiguration,
  localCompanyId,
  localSourceId,
  localTokenVerifier
} from "./local-fixture";
import { handleLocalHttpRequest } from "./local-http";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the local fixture`);
  return value;
}

function rolePool(
  connectionString: string,
  role: "knowledge_ingest" | "knowledge_read" | "knowledge_review"
) {
  return new Pool({
    connectionString,
    options: `-c role=${role}`,
    max: 4,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000
  });
}

async function parseWithLocalContainer(
  reference: ImmutableObjectReference,
  mimeType: string,
  storage: Storage,
  parserUrl: string
) {
  const outputObjectKey = `parser/${reference.sha256}/extraction-v1.json`;
  const response = await fetch(new URL("/parse", parserUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { ...reference, mimeType },
      output: { bucket: localBucket, objectKey: outputObjectKey }
    }),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok)
    throw new Error(`local parser failed with status ${response.status}`);
  const output = await captureExistingObject(
    localBucket,
    outputObjectKey,
    8_000_000,
    storage
  );
  const bytes = await readImmutableObject(output, storage);
  return createExtraction(JSON.parse(bytes.toString("utf8")) as ParserOutput);
}

async function main() {
  if (process.env.KNOWLEDGE_E2E_SYNTHETIC_FIXTURES !== "1")
    throw new Error("Local synthetic identity is disabled");
  const databaseUrl = required("KNOWLEDGE_E2E_DATABASE_URL");
  const parserUrl = required("KNOWLEDGE_E2E_PARSER_URL");
  const reviewPool = rolePool(databaseUrl, "knowledge_review");
  const readPool = rolePool(databaseUrl, "knowledge_read");
  const ingestPool = rolePool(databaseUrl, "knowledge_ingest");
  const fixturePool = new Pool({ connectionString: databaseUrl, max: 2 });
  const storage = new Storage({ projectId: "knowledge-e2e" });
  try {
    await storage.createBucket(localBucket);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      ![409, 412].includes(Number((error as { code?: unknown }).code))
    )
      throw error;
  }

  const identityStore = postgresIdentityStore(readPool);
  const configuration = localCallerConfiguration("e2e-worker");
  const capturedIntakes = new Set<string>();
  const stats = {
    processAttempts: 0,
    parserCalls: 0,
    injectedFailures: 0,
    maximumAttempt: 0
  };
  let failNextParser = false;

  const dependencies: WorkerDependencies = {
    reviewPool,
    readPool,
    ingestPool,
    bucket: localBucket,
    storage,
    verifyHuman: (request, operation) =>
      verifyWorkforceRequest({
        request,
        operation,
        configuration,
        identityStore,
        tokenVerifier: localTokenVerifier
      }),
    machineConfiguration: {
      audience: "e2e-machine",
      callers: [
        {
          callerId: "local-indexer",
          subject: "e2e-indexer",
          companyIds: [localCompanyId],
          sourceIds: [localSourceId],
          capabilities: ["source.index.read"]
        }
      ]
    },
    automationUserId: "automation",
    manualSource: {
      sourceId: localSourceId,
      displayName: "Operations manuals"
    },
    connectorAccessToken: async () => null,
    userDriveAccessToken: async () => null,
    sendOutboxEvent: async (companyId) => {
      await knowledgeInngest.send({
        name: "knowledge/outbox.deliver",
        data: { companyId },
        id: `knowledge-outbox-${companyId}-${crypto.randomUUID()}`
      });
    }
  };
  const worker = createWorkerHandler(dependencies);
  const delivery = createOutboxDeliveryFunction({
    pool: ingestPool,
    companies: [{ companyId: localCompanyId, callerId: "local-indexer" }],
    workerId: `local-worker-${process.pid}`,
    sourceId: localSourceId,
    embeddingProfile: "manual-v1",
    process: async (principal, event, attempt) => {
      stats.processAttempts += 1;
      stats.maximumAttempt = Math.max(stats.maximumAttempt, attempt);
      if (failNextParser && event.entityType === "intake") {
        failNextParser = false;
        stats.injectedFailures += 1;
        throw new Error("injected local parser failure");
      }
      await processKnowledgeOutbox(
        {
          pool: ingestPool,
          bucket: localBucket,
          automationUserId: "automation",
          manualSourceId: localSourceId,
          parseDocument: async (reference, mimeType) => {
            stats.parserCalls += 1;
            return parseWithLocalContainer(
              reference,
              mimeType,
              storage,
              parserUrl
            );
          }
        },
        principal,
        event
      );
    }
  });
  const inngestHandler = serve({
    client: knowledgeInngest,
    functions: [delivery]
  });

  const localHandler = async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      await fixturePool.query("SELECT 1");
      return Response.json({
        status: "ok",
        service: "local-ingest",
        delivery: "inngest"
      });
    }
    if (request.method === "GET" && url.pathname === "/__e2e/status") {
      const outbox = await fixturePool.query<{
        pending: string;
        delivered: string;
        maximumAttempts: string | null;
      }>(
        `SELECT count(*) FILTER (WHERE "deliveredAt" IS NULL)::text AS pending,
                  count(*) FILTER (WHERE "deliveredAt" IS NOT NULL)::text AS delivered,
                  max(attempts)::text AS "maximumAttempts"
             FROM knowledge.outbox WHERE "companyId"=$1`,
        [localCompanyId]
      );
      return Response.json({
        ...stats,
        pending: Number(outbox.rows[0]?.pending ?? 0),
        delivered: Number(outbox.rows[0]?.delivered ?? 0),
        maximumLeaseAttempts: Number(outbox.rows[0]?.maximumAttempts ?? 0)
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/__e2e/fail-next-parser"
    ) {
      failNextParser = true;
      return Response.json({ state: "armed" });
    }
    if (request.method === "POST" && url.pathname === "/__e2e/revoke/bob") {
      await fixturePool.query(
        `UPDATE public."user" SET active=false WHERE id='bob'`
      );
      return Response.json({ state: "revoked" });
    }
    if (request.method === "POST" && url.pathname === "/__e2e/restore/bob") {
      await fixturePool.query(
        `UPDATE public."user" SET active=true WHERE id='bob'`
      );
      return Response.json({ state: "active" });
    }
    if (request.method === "POST" && url.pathname === "/__e2e/cleanup") {
      await cleanCapturedIntakes(fixturePool, [...capturedIntakes]);
      capturedIntakes.clear();
      return new Response(null, { status: 204 });
    }
    const response = await worker(request);
    if (
      request.method === "POST" &&
      url.pathname === "/v1/intake" &&
      response.status === 202
    ) {
      const body = (await response.clone().json()) as { id?: string };
      if (body.id) capturedIntakes.add(body.id);
    }
    return response;
  };
  const server = createServer((incoming, outgoing) => {
    const pathname = new URL(
      incoming.url ?? "/",
      `http://${incoming.headers.host ?? "localhost"}`
    ).pathname;
    if (pathname === "/api/inngest") {
      void inngestHandler(incoming, outgoing);
      return;
    }
    void handleLocalHttpRequest(incoming, outgoing, 52_000_000, localHandler);
  });
  server.requestTimeout = 310_000;
  server.headersTimeout = 10_000;
  server.listen(Number(process.env.PORT ?? "4301"), "0.0.0.0");

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([
      reviewPool.end(),
      readPool.end(),
      ingestPool.end(),
      fixturePool.end()
    ]);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

void main().catch(() => {
  process.exitCode = 1;
});
