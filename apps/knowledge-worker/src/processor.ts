import { createHash } from "node:crypto";
import { withKnowledgeTransaction } from "@carbon/knowledge/database.server";
import { embedCurrentDocumentVersion } from "@carbon/knowledge/indexing/indexer.server";
import type { LeasedOutboxEvent } from "@carbon/knowledge/indexing/outbox.server";
import {
  attachCapturedObject,
  getCapturedIntakeForExtraction,
  persistExtractionGeneration
} from "@carbon/knowledge/intake/extraction";
import {
  getDrivePublicationTarget,
  publishDriveDocumentVersion
} from "@carbon/knowledge/sources/drive-publication.server";
import type { Pool } from "pg";
import { fetchBoundedUrl } from "./fetch-policy";
import type { ImmutableObjectReference } from "./gcs";
import { captureImmutableUpload } from "./gcs";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function processKnowledgeOutbox(
  runtime: {
    pool: Pool;
    bucket: string;
    automationUserId: string;
    manualSourceId?: string;
    parseDocument: (
      reference: ImmutableObjectReference,
      mimeType: string
    ) => Promise<
      ReturnType<typeof import("@carbon/knowledge/intake").createExtraction>
    >;
    loadDriveDocument?: (
      sourceId: string,
      fileId: string,
      mimeType: string
    ) => Promise<{ bytes: Uint8Array; mimeType: string }>;
    embedding?: {
      profile: string;
      embedBatch: (
        texts: readonly string[]
      ) => Promise<
        readonly ({ embedding: readonly number[]; tokenCount: number } | null)[]
      >;
    };
  },
  principal: { companyId: string; callerId: string },
  event: LeasedOutboxEvent
): Promise<void> {
  if (runtime.manualSourceId) {
    if (event.sourceId !== runtime.manualSourceId)
      throw new Error("Manual source unavailable");
    await withKnowledgeTransaction(
      runtime.pool,
      { ...principal, sourceId: runtime.manualSourceId },
      "read",
      async (client) => {
        const source = await client.query(
          `SELECT 1 FROM knowledge.source WHERE "companyId"=$1 AND id=$2 AND kind='upload' AND status='active'`,
          [principal.companyId, runtime.manualSourceId]
        );
        if (!source.rows[0]) throw new Error("Manual source unavailable");
      }
    );
    // Manual publication commits lexical chunks atomically; no external model or
    // connector can be invoked by a document event in this release.
    if (event.entityType === "document") return;
  }
  if (event.entityType === "document" && event.eventType === "upsert") {
    const target = await getDrivePublicationTarget(
      runtime.pool,
      principal,
      event.entityId,
      event.sourceId
    );
    if (target && target.currentSourceRevision !== event.sourceVersion) {
      const payload = asRecord(event.payload);
      const driveFileId =
        typeof payload.driveFileId === "string"
          ? payload.driveFileId
          : target.sourceItemId;
      const sourceMimeType =
        typeof payload.mimeType === "string" ? payload.mimeType : "";
      if (!runtime.loadDriveDocument || !sourceMimeType)
        throw new Error("Drive document acquisition is not configured");
      const acquired = await runtime.loadDriveDocument(
        target.sourceId,
        driveFileId,
        sourceMimeType
      );
      const bytes = Buffer.from(acquired.bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const captured = await captureImmutableUpload({
        bucket: runtime.bucket,
        objectKey: `drive/${principal.companyId}/${target.sourceId}/${driveFileId}/${event.sourceVersion}/${hash}`,
        bytes,
        mimeType: acquired.mimeType
      });
      const reference = {
        bucket: runtime.bucket,
        objectKey: captured.objectKey,
        generation: captured.generation,
        sha256: captured.sha256,
        maxBytes: captured.bytes
      };
      const extraction = await runtime.parseDocument(
        reference,
        captured.mimeType
      );
      await publishDriveDocumentVersion(runtime.pool, principal, {
        documentId: target.documentId,
        sourceId: target.sourceId,
        sourceRevision: event.sourceVersion,
        createdBy: runtime.automationUserId,
        reference: captured,
        extraction,
        parserVersion: "knowledge-parser-job-v1",
        indexGeneration: target.indexGeneration
      });
    }
    if (runtime.embedding)
      await embedCurrentDocumentVersion(runtime.pool, principal, {
        documentId: event.entityId,
        createdBy: runtime.automationUserId,
        embeddingProfile: runtime.embedding.profile,
        embedBatch: runtime.embedding.embedBatch
      });
    return;
  }
  if (event.entityType !== "intake" || event.eventType !== "upsert") return;
  let intake = await getCapturedIntakeForExtraction(
    runtime.pool,
    principal,
    event.entityId
  );
  if (
    runtime.manualSourceId &&
    ["needs-review", "ready"].includes(intake.state)
  )
    return;
  let refs = Array.isArray(intake.inputRefs)
    ? intake.inputRefs.map(asRecord)
    : [];
  let object = refs.find((entry) => entry.kind === "object");
  if (!object) {
    if (runtime.manualSourceId)
      throw new Error(
        "Manual extraction requires an immutable uploaded object"
      );
    const url = refs.find((entry) => entry.kind === "url")?.url;
    if (typeof url !== "string")
      throw new Error("source-reference extraction adapter is not configured");
    const acquired = await fetchBoundedUrl(url);
    const hash = createHash("sha256").update(acquired.bytes).digest("hex");
    const captured = await captureImmutableUpload({
      bucket: runtime.bucket,
      objectKey: `intake/${principal.companyId}/${runtime.automationUserId}/${hash}`,
      bytes: acquired.bytes,
      mimeType: acquired.mimeType
    });
    object = {
      kind: "object",
      objectKey: captured.objectKey,
      generation: captured.generation,
      sha256: captured.sha256,
      mimeType: captured.mimeType,
      bytes: captured.bytes,
      acquiredFrom: acquired.finalUrl
    };
    await attachCapturedObject(runtime.pool, principal, {
      intakeId: event.entityId,
      createdBy: runtime.automationUserId,
      expectedVersion: intake.version,
      object
    });
    intake = await getCapturedIntakeForExtraction(
      runtime.pool,
      principal,
      event.entityId
    );
    refs = Array.isArray(intake.inputRefs)
      ? intake.inputRefs.map(asRecord)
      : [];
    object = refs.find((entry) => entry.kind === "object");
  }
  if (
    !object ||
    typeof object.objectKey !== "string" ||
    typeof object.generation !== "string" ||
    typeof object.sha256 !== "string" ||
    typeof object.mimeType !== "string"
  )
    throw new Error("captured object reference is incomplete");
  const reference = {
    bucket: runtime.bucket,
    objectKey: object.objectKey,
    generation: object.generation,
    sha256: object.sha256,
    maxBytes: typeof object.bytes === "number" ? object.bytes : undefined
  };
  const extraction = await runtime.parseDocument(reference, object.mimeType);
  await persistExtractionGeneration(runtime.pool, principal, {
    intakeId: event.entityId,
    createdBy: runtime.automationUserId,
    expectedGeneration: intake.generation,
    generation: (BigInt(intake.generation) + 1n).toString(),
    providerProfile: "bounded-process-v1",
    sourceVersions: {
      objectGeneration: object.generation,
      contentHash: object.sha256
    },
    extraction
  });
}
