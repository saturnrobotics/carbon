/**
 * Loopback-only Drive connector fixture for `apps/knowledge/tests/drive-source.spec.ts`.
 *
 * It runs the production worker handler, the production Drive sync engine and
 * the production query handler in one process against the labelled disposable
 * PostgreSQL fixture. Google is replaced by an in-memory Drive; identity by the
 * synthetic loopback verifier; the query service's outbound service token by a
 * loopback forwarding seam. No credential, no network, no real Drive.
 *
 * Endpoints on 4301 (worker) and 4302 (query), plus test controls:
 *   POST /__e2e/drive/sync            run one sync and publish pending upserts
 *   POST /__e2e/drive/revoke-folder   drop the reader from the folder and file
 *   POST /__e2e/drive/cleanup         remove every row this fixture created
 */
import { createHash } from "node:crypto";
import type { VerifiedWorkforceIdentity } from "@carbon/knowledge/identity.server";
import { postgresIdentityStore } from "@carbon/knowledge/identity-store.server";
import {
  acknowledgeOutbox,
  claimOutbox,
  confirmOutboxApplied,
  DELIVERY_EVENT_TYPES
} from "@carbon/knowledge/indexing/outbox.server";
import { parseStoredExtraction } from "@carbon/knowledge/intake/contracts";
import {
  getDriveEnrollment,
  persistDriveChangePage,
  recordDriveSyncOutcome
} from "@carbon/knowledge/sources/drive.server";
import {
  getDrivePublicationTarget,
  publishDriveDocumentVersion
} from "@carbon/knowledge/sources/drive-publication.server";
import { Pool } from "pg";
import { createReadHandler } from "../../../knowledge-query/src/query.server";
import type {
  DriveApiClient,
  GoogleChange,
  GoogleFile,
  GooglePermission
} from "../drive-client";
import { databaseDriveLedger, runDriveSync } from "../drive-sync";
import { applyOutboxInvalidation } from "../invalidation";
import { createWorkerHandler, type WorkerDependencies } from "../server";
import {
  localCallerConfiguration,
  localCompanyId,
  localTokenVerifier
} from "./local-fixture";
import { startLocalHttpServer } from "./local-http";

const sourceId = "e2e-drive";
const callerId = "e2e-drive-sync";
const automation = "automation";
const folderMime = "application/vnd.google-apps.folder";
const reader: GooglePermission = {
  id: "perm-bob",
  type: "user",
  emailAddress: "bob@example.com",
  role: "reader"
};

/** The one-page PDF the fixture serves; its text is what the reader searches for. */
function textPdf(text: string): Buffer {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

/** In-memory Drive: a root folder with one manual the reader can open. */
class FakeDrive implements DriveApiClient {
  readonly text = "E2E drive manual DM-100 revision A torque table";
  readonly bytes = textPdf(this.text);
  files = new Map<string, GoogleFile>([
    ["root", { id: "root", name: "Root", mimeType: folderMime, parents: [] }],
    [
      "manual",
      {
        id: "manual",
        name: "Drive manual DM-100",
        mimeType: "application/pdf",
        parents: ["root"],
        version: "1",
        sha256Checksum: createHash("sha256").update(this.bytes).digest("hex")
      }
    ]
  ]);
  permissions = new Map<string, GooglePermission[]>([
    ["root", [reader]],
    ["manual", [reader]]
  ]);
  pending: GoogleChange[] = [];
  token = 1;

  revokeFolder() {
    this.permissions.set("root", []);
    this.permissions.set("manual", []);
    this.pending.push({
      changeType: "file",
      fileId: "root",
      file: this.files.get("root")
    });
  }
  canOpen(fileId: string) {
    return (this.permissions.get(fileId) ?? []).some(
      (permission) => permission.emailAddress === reader.emailAddress
    );
  }
  async getStartPageToken() {
    return String(this.token);
  }
  async listChanges() {
    const changes = this.pending.splice(0);
    this.token += 1;
    return { newStartPageToken: String(this.token), changes };
  }
  async listFiles(input: { parentId?: string }) {
    return {
      files: [...this.files.values()].filter(
        (file) => !input.parentId || file.parents?.includes(input.parentId)
      )
    };
  }
  async getFiles(fileIds: readonly string[]) {
    return new Map(fileIds.map((id) => [id, this.files.get(id) ?? null]));
  }
  async listPermissions(fileIds: readonly string[]) {
    return new Map(fileIds.map((id) => [id, this.permissions.get(id) ?? []]));
  }
}

function principal(actor: "bob" | "alice"): VerifiedWorkforceIdentity {
  return {
    principal: {
      kind: "human",
      actorId: actor,
      companyId: localCompanyId,
      callerId: "knowledge-e2e-loopback",
      sourceIdentity: {
        issuer: "https://cloud.google.com/iap",
        subject: actor === "bob" ? "subject-b" : "subject-a"
      },
      policyVersion: "e2e-test",
      capabilities: ["knowledge.read"]
    },
    companyGroupId: localCompanyId,
    allowedOperations: ["knowledge.query", "knowledge.read"],
    accessLevels: ["e2e-test"],
    assurance: { mode: "carbon-mfa" }
  };
}

function actorFromEvidence(request: Request): "bob" | "alice" {
  const value = request.headers.get("x-portal-user-evidence");
  if (value === "e2e-iap:bob" || value === "e2e-iap:alice")
    return value.slice("e2e-iap:".length) as "bob" | "alice";
  throw new Error("unauthorized");
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

async function main() {
  if (process.env.KNOWLEDGE_E2E_SYNTHETIC_FIXTURES !== "1")
    throw new Error("Local synthetic identity is disabled");
  const databaseUrl = process.env.KNOWLEDGE_E2E_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("KNOWLEDGE_E2E_DATABASE_URL is required");
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const ingestPool = rolePool(databaseUrl, "knowledge_ingest");
  const readPool = rolePool(databaseUrl, "knowledge_read");
  const reviewPool = rolePool(databaseUrl, "knowledge_review");
  const drive = new FakeDrive();
  const machine = { companyId: localCompanyId, callerId, sourceId };
  const sessionUser = (
    await admin.query<{ user: string }>("SELECT session_user AS user")
  ).rows[0]!.user;

  const cleanup = async () => {
    await admin.query(
      `DELETE FROM knowledge.outbox WHERE "companyId"=$1 AND "sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge."grant" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `UPDATE knowledge.document SET "currentVersionId"=NULL,version=version+1 WHERE "companyId"=$1 AND "sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge.chunk c USING knowledge.document d WHERE c."documentId"=d.id AND c."companyId"=d."companyId" AND d."companyId"=$1 AND d."sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge."documentVersion" v USING knowledge.document d WHERE v."documentId"=d.id AND v."companyId"=d."companyId" AND d."companyId"=$1 AND d."sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge.document WHERE "companyId"=$1 AND "sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge."driveItem" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge."driveEnrollment" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge."sourceUserBinding" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge.source WHERE "companyId"=$1 AND id=$2`,
      [localCompanyId, sourceId]
    );
    await admin.query(
      `DELETE FROM knowledge."identityBinding" WHERE "companyId"=$1 AND id='e2e-drive-bob-binding'`,
      [localCompanyId]
    );
  };
  await cleanup();
  await admin.query(
    `INSERT INTO knowledge.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
     VALUES ($1,$2,'bob','drive','drive-e2e','Engineering drive','bob','source-restricted',$3::jsonb)`,
    [
      sourceId,
      localCompanyId,
      JSON.stringify({
        machineCallers: [callerId],
        ingestDatabaseRoles: [sessionUser]
      })
    ]
  );
  await admin.query(
    `INSERT INTO knowledge."driveEnrollment" ("companyId","createdBy","sourceId",corpora,"driveId","rootFolderIds","oauthScope","credentialSecretRef")
     VALUES ($1,'bob',$2,'drive','drive-e2e',ARRAY['root'],'https://www.googleapis.com/auth/drive.readonly','projects/synthetic/secrets/drive-e2e/versions/1')`,
    [localCompanyId, sourceId]
  );
  await admin.query(
    `INSERT INTO knowledge."sourceUserBinding"(id,"companyId","createdBy","sourceId","canonicalUserId","sourceUserId",active)
     VALUES ('e2e-drive-bob',$1,'bob',$2,'bob','bob@example.com',true)`,
    [localCompanyId, sourceId]
  );
  await admin.query(
    `INSERT INTO knowledge."grant"(id,"companyId","createdBy","sourceId","subjectKind","subjectId",capability,origin,"policyVersion")
     VALUES ('e2e-drive-bob-local',$1,'bob',$2,'user','bob','read','local',1),
            ('e2e-drive-bob-member',$1,'bob',$2,'user','bob','read','source',1)`,
    [localCompanyId, sourceId]
  );
  await admin.query(
    `INSERT INTO knowledge."identityBinding" (id,"companyId","createdBy",issuer,subject,"canonicalUserId",active,"revocationVersion",capabilities)
     VALUES ('e2e-drive-bob-binding',$1,'bob','https://cloud.google.com/iap','subject-b','bob',true,1,ARRAY['knowledge.read']::text[])`,
    [localCompanyId]
  );

  const workerId = `local-drive-${process.pid}`;
  const syncNow = async () => {
    const enrollment = await getDriveEnrollment(ingestPool, machine, sourceId);
    const result = await runDriveSync({
      client: drive,
      enrollment,
      ledger: databaseDriveLedger(ingestPool, machine, sourceId),
      persistPage: (page) =>
        persistDriveChangePage(ingestPool, machine, {
          sourceId,
          automationUserId: automation,
          ...page
        })
    });
    await recordDriveSyncOutcome(ingestPool, machine, {
      sourceId,
      automationUserId: automation,
      status: "succeeded",
      reconciled: result.reconciled
    });
    // Publication of the acquired bytes; the parser and object store are
    // exercised by the docker manual stack, so the extraction is derived here.
    const upserts = await claimOutbox(
      ingestPool,
      machine,
      workerId,
      50,
      DELIVERY_EVENT_TYPES
    );
    for (const event of upserts) {
      const target = await getDrivePublicationTarget(
        ingestPool,
        machine,
        event.entityId,
        sourceId
      );
      if (target && target.currentSourceRevision !== event.sourceVersion)
        await publishDriveDocumentVersion(ingestPool, machine, {
          documentId: target.documentId,
          sourceId,
          sourceRevision: event.sourceVersion,
          createdBy: automation,
          reference: {
            objectKey: `drive/${sourceId}/${target.sourceItemId}`,
            generation: "1",
            sha256: createHash("sha256").update(drive.bytes).digest("hex"),
            mimeType: "application/pdf",
            bytes: drive.bytes.length
          },
          extraction: parseStoredExtraction({
            fields: { title: target.title },
            evidence: { manual: [{ page: 1, text: drive.text }] },
            unresolved: [],
            warnings: []
          }),
          parserVersion: "e2e-drive-fixture",
          indexGeneration: target.indexGeneration
        });
      await confirmOutboxApplied(ingestPool, machine, event, "manual-v1");
      await acknowledgeOutbox(ingestPool, machine, workerId, [event.id]);
    }
    const invalidations = await claimOutbox(
      ingestPool,
      machine,
      workerId,
      100,
      ["acl-change", "delete"]
    );
    if (invalidations.length)
      await applyOutboxInvalidation(
        ingestPool,
        machine,
        workerId,
        invalidations
      );
    return result;
  };

  const dependencies: WorkerDependencies & { fetchImpl: typeof fetch } = {
    reviewPool,
    readPool,
    ingestPool,
    bucket: "e2e-memory-bucket",
    verifyHuman: async (request) => principal(actorFromEvidence(request)),
    machineConfiguration: {
      audience: "e2e-machine",
      callers: [
        {
          callerId,
          subject: "e2e-drive-sync",
          companyIds: [localCompanyId],
          sourceIds: [sourceId],
          capabilities: ["source.changes.read"]
        }
      ]
    },
    automationUserId: automation,
    manualSource: { sourceId: "source-b", displayName: "Operations manuals" },
    connectorAccessToken: async () => "connector-e2e",
    userDriveAccessToken: async (human) =>
      human.actorId === "bob" ? "delegated-bob" : null,
    requestDriveSync: async () => {
      await syncNow();
    },
    // The reader-delegated live check, answered by the in-memory Drive.
    fetchImpl: (async (input: string | URL | Request) => {
      const fileId = decodeURIComponent(
        new URL(String(input)).pathname.split("/").at(-1) ?? ""
      );
      return drive.canOpen(fileId)
        ? Response.json({
            id: fileId,
            trashed: false,
            capabilities: { canDownload: true }
          })
        : new Response("", { status: 403 });
    }) as typeof fetch
  };
  const worker = createWorkerHandler(dependencies);
  const workerServer = startLocalHttpServer({
    port: 4301,
    maximumBytes: 1_000_000,
    handler: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        await admin.query("SELECT 1");
        return Response.json({ status: "ok", service: "local-drive" });
      }
      if (request.method === "POST" && url.pathname === "/__e2e/drive/sync")
        return Response.json(await syncNow());
      if (
        request.method === "POST" &&
        url.pathname === "/__e2e/drive/revoke-folder"
      ) {
        drive.revokeFolder();
        return Response.json({ state: "revoked" });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/__e2e/drive/cleanup"
      ) {
        await cleanup();
        return new Response(null, { status: 204 });
      }
      return worker(request);
    }
  });

  // The query service reaches the worker's live check in-process: the same
  // handler, the same forwarded evidence, no service token to mint.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "drive-check.local")
      return originalFetch(input as never, init);
    return worker(
      new Request(
        new URL(`${url.pathname}${url.search}`, "http://127.0.0.1:4301"),
        {
          method: init?.method ?? "POST",
          headers: init?.headers
        }
      )
    );
  }) as typeof fetch;
  const query = createReadHandler({
    pool: readPool,
    configuration: localCallerConfiguration("e2e-query"),
    identityStore: postgresIdentityStore(readPool),
    tokenVerifier: localTokenVerifier,
    cacheStore: {
      get: async () => undefined,
      set: async () => {
        // The browser harness disables caching; revocation of a warm cache is
        // proven by the packages/knowledge integration suite.
      }
    },
    origin: "https://localhost:4200",
    businessTimezone: "UTC",
    workerOrigin: "https://drive-check.local/",
    workerAudience: "e2e-worker",
    driveForwardingHeaders: async (options) =>
      new Headers({
        authorization: "Bearer e2e-service",
        "x-portal-user-evidence":
          options.request.headers.get("x-portal-user-evidence") ?? "",
        "x-portal-company-id": options.companyId
      })
  });
  const queryServer = startLocalHttpServer({
    port: 4302,
    maximumBytes: 32_768,
    handler: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({ status: "ok", service: "local-drive-query" });
      if (request.method === "POST" && url.pathname === "/v1/query")
        return query(request);
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  });

  const close = async () => {
    await new Promise<void>((resolve) => workerServer.close(() => resolve()));
    await new Promise<void>((resolve) => queryServer.close(() => resolve()));
    await cleanup().catch(() => undefined);
    await Promise.all([
      admin.end(),
      ingestPool.end(),
      readPool.end(),
      reviewPool.end()
    ]);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

void main().catch(() => {
  process.exitCode = 1;
});
