import { createHash } from "node:crypto";
import {
  getAuthorizedDocumentVersion,
  tombstoneManualDocument
} from "@carbon/knowledge/documents.server";
import {
  createRemoteWorkforceIdentityStore,
  GoogleWorkforceTokenVerifier,
  parseTrustedCallerConfiguration,
  type VerifiedWorkforceIdentity,
  verifyWorkforceRequest
} from "@carbon/knowledge/identity.server";
import {
  captureIdentity,
  getManualUploadSource,
  type IntakeInput,
  manualReviewDecisions,
  persistCapturedIntake,
  reviewedManualMetadataSchema,
  saveReviewDecisions
} from "@carbon/knowledge/intake";
import {
  getIntakeForReview,
  publishReviewedIntake
} from "@carbon/knowledge/intake/publish.server";
import { readManualSourceConfiguration } from "@carbon/knowledge/release-profile";
import type { Storage } from "@google-cloud/storage";
import { Pool } from "pg";
import { createDriveTokenBroker } from "./drive-tokens";
import { captureImmutableUpload, readImmutableObject } from "./gcs";
import {
  type MachineCallerConfiguration,
  parseMachineCallerConfiguration
} from "./machine-auth";
import { manualMimeTypes, validateManualFile } from "./manual-file";

type HumanPrincipal = VerifiedWorkforceIdentity["principal"];

export type WorkerDependencies = {
  reviewPool: Pool;
  readPool: Pool;
  ingestPool: Pool;
  bucket: string;
  storage?: Storage;
  verifyHuman: (
    request: Request,
    operation: string
  ) => Promise<VerifiedWorkforceIdentity>;
  machineConfiguration: MachineCallerConfiguration;
  automationUserId: string;
  manualSource: { sourceId: string; displayName: string };
  connectorAccessToken: (sourceId: string) => Promise<string | null>;
  userDriveAccessToken: (
    principal: HumanPrincipal,
    sourceId: string
  ) => Promise<string | null>;
  sendOutboxEvent?: (companyId: string) => Promise<void>;
};

function databasePool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 2_000
  });
  pool.on("error", () => {
    /* Never log database addresses or credentials. */
  });
  return pool;
}

export function configuredWorkerDependencies(
  environment: NodeJS.ProcessEnv = process.env
): WorkerDependencies | null {
  const reviewUrl = environment.KNOWLEDGE_REVIEW_DATABASE_URL;
  const readUrl = environment.KNOWLEDGE_READ_DATABASE_URL;
  const ingestUrl = environment.KNOWLEDGE_INGEST_DATABASE_URL;
  const bucket = environment.KNOWLEDGE_OBJECT_BUCKET;
  const callersJson = environment.KNOWLEDGE_TRUSTED_CALLERS_JSON;
  const machineJson = environment.KNOWLEDGE_MACHINE_CALLERS_JSON;
  const identityUrl = environment.KNOWLEDGE_IDENTITY_URL;
  const identityAudience = environment.KNOWLEDGE_IDENTITY_AUDIENCE;
  const automationUserId = environment.KNOWLEDGE_AUTOMATION_USER_ID;
  if (
    !reviewUrl ||
    !readUrl ||
    !ingestUrl ||
    !bucket ||
    !callersJson ||
    !machineJson ||
    !identityUrl ||
    !identityAudience ||
    !automationUserId
  )
    return null;
  const configuration = parseTrustedCallerConfiguration(callersJson);
  const tokenVerifier = new GoogleWorkforceTokenVerifier();
  const tokenBroker =
    environment.KNOWLEDGE_DRIVE_TOKEN_BROKER_URL &&
    environment.KNOWLEDGE_DRIVE_TOKEN_BROKER_AUDIENCE
      ? createDriveTokenBroker({
          url: environment.KNOWLEDGE_DRIVE_TOKEN_BROKER_URL,
          audience: environment.KNOWLEDGE_DRIVE_TOKEN_BROKER_AUDIENCE
        })
      : undefined;
  return {
    reviewPool: databasePool(reviewUrl),
    readPool: databasePool(readUrl),
    ingestPool: databasePool(ingestUrl),
    bucket,
    verifyHuman: (request, operation) =>
      verifyWorkforceRequest({
        request,
        operation,
        configuration,
        tokenVerifier,
        identityStore: createRemoteWorkforceIdentityStore({
          request,
          resolverUrl: identityUrl,
          resolverAudience: identityAudience
        })
      }),
    machineConfiguration: parseMachineCallerConfiguration(machineJson),
    automationUserId,
    manualSource: readManualSourceConfiguration(environment),
    connectorAccessToken: (sourceId) =>
      tokenBroker?.({ kind: "connector", sourceId }) ?? Promise.resolve(null),
    userDriveAccessToken: (principal, sourceId) =>
      tokenBroker?.({ kind: "user", sourceId, actorId: principal.actorId }) ??
      Promise.resolve(null)
  };
}

function errorResponse(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } }
  );
}

async function verifyHumanCapability(
  request: Request,
  operation: string,
  dependencies: WorkerDependencies
): Promise<VerifiedWorkforceIdentity> {
  const identity = await dependencies.verifyHuman(request, operation);
  if (!identity.principal.capabilities.includes(operation))
    throw new Error("unauthorized workforce capability");
  return identity;
}

async function captureRequest(
  request: Request,
  principal: HumanPrincipal,
  dependencies: WorkerDependencies
) {
  const contentType = request.headers.get("content-type") ?? "";
  const databasePrincipal = {
    companyId: principal.companyId,
    actorId: principal.actorId,
    callerId: principal.callerId
  };
  const source = await getManualUploadSource(
    dependencies.reviewPool,
    databasePrincipal,
    dependencies.manualSource.sourceId
  );
  let input: IntakeInput;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    if (
      form.has("sourceId") ||
      form.has("classification") ||
      form.has("sourceUrl")
    )
      throw new Error("manual source is server configured");
    const file = form.get("document");
    if (file instanceof File && file.size) {
      if (file.size > 50_000_000 || !manualMimeTypes.has(file.type))
        throw new Error("unsupported intake file");
      const bytes = Buffer.from(await file.arrayBuffer());
      validateManualFile(file.type, bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const captured = await captureImmutableUpload(
        {
          bucket: dependencies.bucket,
          objectKey: `intake/${principal.companyId}/${principal.actorId}/${hash}`,
          bytes,
          mimeType: file.type
        },
        dependencies.storage
      );
      input = {
        kind: "object",
        objectKey: captured.objectKey,
        generation: captured.generation,
        sha256: captured.sha256,
        mimeType: captured.mimeType,
        bytes: captured.bytes
      };
    } else throw new Error("a PDF or image is required");
  } else throw new Error("multipart manual upload is required");
  const captured = captureIdentity({
    sourceId: source.sourceId,
    ownerId: principal.actorId,
    acl: source.classification,
    input
  });
  const persisted = await persistCapturedIntake(
    dependencies.reviewPool,
    databasePrincipal,
    captured
  );
  await dependencies
    .sendOutboxEvent?.(principal.companyId)
    .catch(() => undefined);
  return Response.json(persisted, {
    status: 202,
    headers: { "cache-control": "no-store" }
  });
}

export function createWorkerHandler(
  dependencies: WorkerDependencies | null
): (request: Request) => Promise<Response> {
  if (!dependencies)
    return async () => errorResponse(503, "worker_not_configured");
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/v1/intake") {
        const identity = await verifyHumanCapability(
          request,
          "knowledge.intake.capture",
          dependencies
        );
        return captureRequest(request, identity.principal, dependencies);
      }
      const intakeMatch = url.pathname.match(/^\/v1\/intake\/([^/]+)$/);
      if (intakeMatch && request.method === "GET") {
        const identity = await verifyHumanCapability(
          request,
          "knowledge.intake.review",
          dependencies
        );
        const intake = await getIntakeForReview(
          dependencies.reviewPool,
          {
            companyId: identity.principal.companyId,
            actorId: identity.principal.actorId,
            callerId: identity.principal.callerId
          },
          decodeURIComponent(intakeMatch[1] ?? "")
        );
        if (intake.sourceId !== dependencies.manualSource.sourceId)
          return errorResponse(404, "intake_not_found");
        return Response.json(
          { intake },
          { headers: { "cache-control": "no-store" } }
        );
      }
      const reviewMatch = url.pathname.match(/^\/v1\/intake\/([^/]+)\/review$/);
      if (reviewMatch && request.method === "POST") {
        const identity = await verifyHumanCapability(
          request,
          "knowledge.intake.review",
          dependencies
        );
        const body = (await request.json()) as Record<string, unknown>;
        if (
          typeof body.expectedGeneration !== "string" ||
          typeof body.expectedVersion !== "string"
        )
          return errorResponse(422, "invalid_review");
        const review = manualReviewDecisions(
          reviewedManualMetadataSchema.parse(body.metadata)
        );
        await saveReviewDecisions(
          dependencies.reviewPool,
          {
            companyId: identity.principal.companyId,
            actorId: identity.principal.actorId,
            callerId: identity.principal.callerId
          },
          {
            intakeId: decodeURIComponent(reviewMatch[1] ?? ""),
            expectedGeneration: body.expectedGeneration,
            expectedVersion: body.expectedVersion,
            expectedSourceId: dependencies.manualSource.sourceId,
            decisions: review.decisions,
            unresolved: review.unresolved
          }
        );
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" }
        });
      }
      const publishMatch = url.pathname.match(
        /^\/v1\/intake\/([^/]+)\/publish$/
      );
      if (publishMatch && request.method === "POST") {
        const identity = await verifyHumanCapability(
          request,
          "knowledge.intake.publish",
          dependencies
        );
        const body = (await request.json()) as Record<string, unknown>;
        if (
          typeof body.expectedGeneration !== "string" ||
          typeof body.expectedVersion !== "string" ||
          typeof body.requestId !== "string"
        )
          return errorResponse(422, "invalid_publish");
        const published = await publishReviewedIntake(
          dependencies.reviewPool,
          {
            companyId: identity.principal.companyId,
            actorId: identity.principal.actorId,
            callerId: identity.principal.callerId
          },
          {
            intakeId: decodeURIComponent(publishMatch[1] ?? ""),
            expectedGeneration: body.expectedGeneration,
            expectedVersion: body.expectedVersion,
            expectedSourceId: dependencies.manualSource.sourceId,
            requestId: body.requestId
          }
        );
        await dependencies
          .sendOutboxEvent?.(identity.principal.companyId)
          .catch(() => undefined);
        return Response.json(published, {
          headers: { "cache-control": "no-store" }
        });
      }
      const deleteMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)$/);
      if (deleteMatch && request.method === "DELETE") {
        const identity = await verifyHumanCapability(
          request,
          "knowledge.document.delete",
          dependencies
        );
        const body = (await request.json()) as Record<string, unknown>;
        if (typeof body.requestId !== "string" || !body.requestId.trim())
          return errorResponse(422, "invalid_delete");
        const deleted = await tombstoneManualDocument(
          dependencies.reviewPool,
          {
            companyId: identity.principal.companyId,
            actorId: identity.principal.actorId,
            callerId: identity.principal.callerId
          },
          {
            documentId: decodeURIComponent(deleteMatch[1] ?? ""),
            sourceId: dependencies.manualSource.sourceId,
            requestId: body.requestId
          }
        );
        return Response.json(deleted, {
          headers: { "cache-control": "no-store" }
        });
      }
      const documentMatch = url.pathname.match(
        /^\/v1\/documents\/([^/]+)\/versions\/([^/]+)$/
      );
      if (documentMatch && request.method === "GET") {
        const identity = await verifyHumanCapability(
          request,
          "knowledge.document.download",
          dependencies
        );
        const principal = {
          companyId: identity.principal.companyId,
          actorId: identity.principal.actorId,
          callerId: identity.principal.callerId
        };
        const version = await getAuthorizedDocumentVersion(
          dependencies.readPool,
          principal,
          decodeURIComponent(documentMatch[1] ?? ""),
          decodeURIComponent(documentMatch[2] ?? "")
        );
        if (
          !version ||
          version.sourceId !== dependencies.manualSource.sourceId ||
          version.sourceKind !== "upload"
        )
          return errorResponse(404, "document_not_found");
        const bytes = await readImmutableObject(
          {
            bucket: dependencies.bucket,
            objectKey: version.objectKey,
            generation: version.objectGeneration,
            sha256: version.contentHash,
            maxBytes: Number(version.byteCount)
          },
          dependencies.storage
        );
        const currentIdentity = await verifyHumanCapability(
          request,
          "knowledge.document.download",
          dependencies
        );
        if (
          currentIdentity.principal.actorId !== principal.actorId ||
          currentIdentity.principal.companyId !== principal.companyId
        )
          return errorResponse(403, "document_access_revoked");
        const current = await getAuthorizedDocumentVersion(
          dependencies.readPool,
          principal,
          version.documentId,
          version.documentVersionId
        );
        if (
          !current ||
          current.contentHash !== version.contentHash ||
          current.objectGeneration !== version.objectGeneration
        )
          return errorResponse(403, "document_access_revoked");
        return new Response(new Uint8Array(bytes), {
          headers: {
            "content-type": version.mimeType,
            "content-length": String(bytes.length),
            "content-disposition": `attachment; filename="${version.documentId.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
          }
        });
      }
      return errorResponse(404, "not_found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "request_failed";
      if (message.includes("unauthorized"))
        return errorResponse(401, "unauthorized");
      if (
        (error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "42501") ||
        message.includes("manual cannot be deleted")
      )
        return errorResponse(403, "forbidden");
      if (message.includes("changed"))
        return errorResponse(409, "version_conflict");
      if (
        (error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "ZodError") ||
        message.includes("cannot publish") ||
        message.includes("invalid") ||
        message.includes("required") ||
        message.includes("unsupported")
      )
        return errorResponse(422, "invalid_request");
      return errorResponse(503, "service_unavailable");
    }
  };
}
