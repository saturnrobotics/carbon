import { createHash } from "node:crypto";
import { portalPoolConfig } from "@carbon/portal/database.server";
import {
  getAuthorizedDocumentVersion,
  tombstoneManualDocument
} from "@carbon/portal/documents.server";
import {
  createRemoteWorkforceIdentityStore,
  GoogleWorkforceTokenVerifier,
  parseTrustedCallerConfiguration,
  type VerifiedWorkforceIdentity,
  verifyWorkforceRequest
} from "@carbon/portal/identity.server";
import {
  captureIdentity,
  getManualUploadSource,
  getWritableUploadSources,
  type IntakeInput,
  manualReviewDecisions,
  persistCapturedIntake,
  reviewedManualMetadataSchema,
  saveReviewDecisions
} from "@carbon/portal/intake";
import {
  getIntakeForReview,
  publishReviewedIntake
} from "@carbon/portal/intake/publish.server";
import { readManualSourceConfiguration } from "@carbon/portal/release-profile";
import type { Storage } from "@google-cloud/storage";
import { Pool } from "pg";
import { type DriveSyncRequest, handleDriveRoute } from "./drive-routes";
import { createDriveTokenBroker } from "./drive-tokens";
import { fetchBoundedUrl } from "./fetch-policy";
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
  /** Bounded HTTPS acquisition for URL intake; defaults to the fetch policy. */
  fetchUrl?: typeof fetchBoundedUrl;
  /** Present only when a Drive sync function is registered (never under manual-v1). */
  requestDriveSync?: (input: DriveSyncRequest) => Promise<void>;
};

function databasePool(connectionString: string): Pool {
  const pool = new Pool(
    portalPoolConfig({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 2_000
    })
  );
  pool.on("error", () => {
    /* Never log database addresses or credentials. */
  });
  return pool;
}

export function configuredWorkerDependencies(
  environment: NodeJS.ProcessEnv = process.env
): WorkerDependencies | null {
  const reviewUrl = environment.PORTAL_REVIEW_DATABASE_URL;
  const readUrl = environment.PORTAL_READ_DATABASE_URL;
  const ingestUrl = environment.PORTAL_INGEST_DATABASE_URL;
  const bucket = environment.PORTAL_OBJECT_BUCKET;
  const callersJson = environment.PORTAL_TRUSTED_CALLERS_JSON;
  const machineJson = environment.PORTAL_MACHINE_CALLERS_JSON;
  const identityUrl = environment.PORTAL_IDENTITY_URL;
  const identityAudience = environment.PORTAL_IDENTITY_AUDIENCE;
  const automationUserId = environment.PORTAL_AUTOMATION_USER_ID;
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
    environment.PORTAL_DRIVE_TOKEN_BROKER_URL &&
    environment.PORTAL_DRIVE_TOKEN_BROKER_AUDIENCE
      ? createDriveTokenBroker({
          url: environment.PORTAL_DRIVE_TOKEN_BROKER_URL,
          audience: environment.PORTAL_DRIVE_TOKEN_BROKER_AUDIENCE
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

async function selectedUploadSource(
  form: FormData,
  principal: HumanPrincipal,
  dependencies: WorkerDependencies
): Promise<{ sourceId: string; classification: string }> {
  const databasePrincipal = {
    companyId: principal.companyId,
    actorId: principal.actorId,
    callerId: principal.callerId
  };
  const requested = form.get("sourceId");
  if (typeof requested !== "string" || !requested.trim())
    return getManualUploadSource(
      dependencies.reviewPool,
      databasePrincipal,
      dependencies.manualSource.sourceId
    );
  // The browser may only choose among libraries this actor can capture into.
  // This release exposes exactly the configured manual library.
  const writable = await getWritableUploadSources(
    dependencies.reviewPool,
    databasePrincipal,
    { onlySourceId: dependencies.manualSource.sourceId }
  );
  const selected = writable.find((source) => source.sourceId === requested);
  if (!selected) throw new Error("forbidden library selection");
  return {
    sourceId: selected.sourceId,
    classification: selected.classification
  };
}

function uploadedFile(
  form: FormData,
  field: "document" | "photo"
): File | null {
  const value = form.get(field);
  return value instanceof File && value.size ? value : null;
}

/**
 * The uploaded name, bounded and stripped of the directory the browser may have
 * prefixed. It becomes the proposed title, so it is caller-supplied text that
 * reaches a reviewer's screen: keep it short, one line, and path-free.
 */
function capturedFileName(value: string | undefined): string | undefined {
  const name = (value ?? "")
    .split(/[/\\]/)
    .at(-1)
    ?.replace(/[\p{C}\s]+/gu, " ")
    .trim()
    .slice(0, 255)
    .trim();
  return name || undefined;
}

async function acquireByUrl(
  value: string,
  dependencies: WorkerDependencies
): Promise<{ bytes: Buffer; mimeType: string; finalUrl: string }> {
  try {
    return await (dependencies.fetchUrl ?? fetchBoundedUrl)(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    throw new Error(`acquisition failed: ${reason}`);
  }
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
  if (!contentType.includes("multipart/form-data"))
    throw new Error("multipart manual upload is required");
  const form = await request.formData();
  if (form.has("classification"))
    throw new Error("invalid intake: access follows the selected library");
  const source = await selectedUploadSource(form, principal, dependencies);
  const file = uploadedFile(form, "document") ?? uploadedFile(form, "photo");
  const sourceUrl = form.get("sourceUrl");
  const url =
    typeof sourceUrl === "string" && sourceUrl.trim() ? sourceUrl.trim() : null;
  if (file && url) throw new Error("invalid intake: choose a file or a URL");
  let bytes: Buffer;
  let mimeType: string;
  let acquiredFrom: string | undefined;
  let fileName: string | undefined;
  if (file) {
    if (file.size > 50_000_000 || !manualMimeTypes.has(file.type))
      throw new Error("unsupported intake file");
    bytes = Buffer.from(await file.arrayBuffer());
    mimeType = file.type;
    fileName = capturedFileName(file.name);
  } else if (url) {
    const acquired = await acquireByUrl(url, dependencies);
    if (!manualMimeTypes.has(acquired.mimeType))
      throw new Error("acquisition failed: unsupported intake content type");
    bytes = acquired.bytes;
    mimeType = acquired.mimeType;
    acquiredFrom = acquired.finalUrl;
  } else throw new Error("a PDF, image, or HTTPS URL is required");
  validateManualFile(mimeType, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const captured = await captureImmutableUpload(
    {
      bucket: dependencies.bucket,
      objectKey: `intake/${principal.companyId}/${principal.actorId}/${hash}`,
      bytes,
      mimeType
    },
    dependencies.storage
  );
  const input: IntakeInput = {
    kind: "object",
    objectKey: captured.objectKey,
    generation: captured.generation,
    sha256: captured.sha256,
    mimeType: captured.mimeType,
    bytes: captured.bytes
  };
  const identity = captureIdentity({
    sourceId: source.sourceId,
    ownerId: principal.actorId,
    acl: source.classification,
    input
  });
  const persisted = await persistCapturedIntake(
    dependencies.reviewPool,
    databasePrincipal,
    {
      ...identity,
      ...(acquiredFrom ? { acquiredFrom } : {}),
      ...(fileName ? { fileName } : {})
    }
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
      if (request.method === "GET" && url.pathname === "/v1/sources/writable") {
        const identity = await verifyHumanCapability(
          request,
          "portal.intake.capture",
          dependencies
        );
        const sources = await getWritableUploadSources(
          dependencies.reviewPool,
          {
            companyId: identity.principal.companyId,
            actorId: identity.principal.actorId,
            callerId: identity.principal.callerId
          },
          { onlySourceId: dependencies.manualSource.sourceId }
        );
        return Response.json(
          { actorId: identity.principal.actorId, sources },
          { headers: { "cache-control": "no-store" } }
        );
      }
      if (request.method === "POST" && url.pathname === "/v1/intake") {
        const identity = await verifyHumanCapability(
          request,
          "portal.intake.capture",
          dependencies
        );
        // Awaited so a capture failure reaches the error mapping below instead
        // of escaping as an unhandled rejection from the returned promise.
        return await captureRequest(request, identity.principal, dependencies);
      }
      const intakeMatch = url.pathname.match(/^\/v1\/intake\/([^/]+)$/);
      if (intakeMatch && request.method === "GET") {
        const identity = await verifyHumanCapability(
          request,
          "portal.intake.review",
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
          "portal.intake.review",
          dependencies
        );
        const body = (await request.json()) as Record<string, unknown>;
        if (
          typeof body.expectedGeneration !== "string" ||
          typeof body.expectedVersion !== "string"
        )
          return errorResponse(422, "invalid_review");
        const review = manualReviewDecisions(
          reviewedManualMetadataSchema.parse(body.metadata),
          body.item
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
          "portal.intake.publish",
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
          "portal.document.delete",
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
          "portal.document.download",
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
          "portal.document.download",
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
      const drive = await handleDriveRoute(request, url, dependencies);
      if (drive) return drive;
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
      if (message.startsWith("acquisition failed"))
        return errorResponse(422, "acquisition_failed");
      if (message.includes("forbidden")) return errorResponse(403, "forbidden");
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
