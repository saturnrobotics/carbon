import { createHash } from "node:crypto";
import type { DatabasePrincipal } from "@carbon/portal/database.server";
import { withPortalTransaction } from "@carbon/portal/database.server";
import type { VerifiedWorkforceIdentity } from "@carbon/portal/identity.server";
import {
  getDriveItemForAccess,
  listDriveEnrollments,
  matchesDriveNotificationChannel
} from "@carbon/portal/sources/drive.server";
import type { Pool } from "pg";
import { liveDriveDocumentAccess } from "./drive-permissions";
import type { MachineCallerConfiguration } from "./machine-auth";

export type DriveSyncRequest = {
  companyId: string;
  sourceId: string;
  reason: "hint" | "requested";
};

export type DriveRouteDependencies = {
  readPool: Pool;
  reviewPool: Pool;
  ingestPool: Pool;
  machineConfiguration: MachineCallerConfiguration;
  verifyHuman: (
    request: Request,
    operation: string
  ) => Promise<VerifiedWorkforceIdentity>;
  userDriveAccessToken: (
    principal: VerifiedWorkforceIdentity["principal"],
    sourceId: string
  ) => Promise<string | null>;
  requestDriveSync?: (input: DriveSyncRequest) => Promise<void>;
  fetchImpl?: typeof fetch;
};

function noStore(body: unknown, status: number): Response {
  return body === null
    ? new Response(null, { status, headers: { "cache-control": "no-store" } })
    : Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** The worker's own machine identity for a Drive source, if it syncs one. */
export function driveMachinePrincipal(
  configuration: MachineCallerConfiguration,
  companyId: string,
  sourceId: string
): DatabasePrincipal | null {
  const caller = configuration.callers.find(
    (entry) =>
      entry.capabilities.includes("source.changes.read") &&
      entry.companyIds.includes(companyId) &&
      entry.sourceIds.includes(sourceId)
  );
  return caller ? { companyId, callerId: caller.callerId, sourceId } : null;
}

async function verifyReader(
  request: Request,
  dependencies: DriveRouteDependencies
) {
  const identity = await dependencies.verifyHuman(request, "portal.read");
  if (!identity.principal.capabilities.includes("portal.read"))
    throw new Error("unauthorized workforce capability");
  return identity;
}

/**
 * Drive routes of the ingestion service. Returns `null` for any other path so
 * the caller's routing is untouched. Every response is `no-store`; access
 * answers carry no body, so a denied reader learns nothing about the item.
 */
export async function handleDriveRoute(
  request: Request,
  url: URL,
  dependencies: DriveRouteDependencies
): Promise<Response | null> {
  const access = url.pathname.match(
    /^\/v1\/drive\/([^/]+)\/documents\/([^/]+)\/access$/
  );
  if (access && request.method === "POST") {
    const sourceId = decodeURIComponent(access[1] ?? "");
    const fileId = decodeURIComponent(access[2] ?? "");
    const identity = await verifyReader(request, dependencies);
    const principal = identity.principal;
    const human: DatabasePrincipal = {
      companyId: principal.companyId,
      actorId: principal.actorId,
      callerId: principal.callerId
    };
    // The reader's own row policy decides whether the document exists for them.
    const visible = await withPortalTransaction(
      dependencies.readPool,
      human,
      "read",
      async (client) =>
        (
          await client.query(
            `SELECT 1 FROM portal.document d JOIN portal.source s ON s."companyId"=d."companyId" AND s.id=d."sourceId"
             WHERE d."companyId"=$1 AND d."sourceId"=$2 AND d."sourceItemId"=$3 AND s.kind='drive'
               AND d.status='published' AND d."deletedAt" IS NULL`,
            [principal.companyId, sourceId, fileId]
          )
        ).rows.length === 1
    );
    if (!visible) return noStore({ error: "document_not_found" }, 404);
    const machine = driveMachinePrincipal(
      dependencies.machineConfiguration,
      principal.companyId,
      sourceId
    );
    if (!machine) return noStore(null, 403);
    const item = await getDriveItemForAccess(
      dependencies.ingestPool,
      machine,
      sourceId,
      fileId
    );
    if (!item) return noStore(null, 403);
    const allowed = await liveDriveDocumentAccess({
      accessToken: await dependencies.userDriveAccessToken(principal, sourceId),
      fileId: item.fileId,
      shortcutTargetId: item.shortcutTargetId,
      fetchImpl: dependencies.fetchImpl
    });
    return noStore(null, allowed ? 204 : 403);
  }

  const notification = url.pathname.match(
    /^\/v1\/drive\/([^/]+)\/notifications$/
  );
  if (notification && request.method === "POST") {
    // A Google push notification is a hint. It is never authenticated as a
    // caller and it carries nothing the connector acts on; a matching channel
    // only schedules the cursor-based sync that the cron would run anyway.
    // The answer is the same whether or not the channel exists.
    const sourceId = decodeURIComponent(notification[1] ?? "");
    const channelId = request.headers.get("x-goog-channel-id")?.trim();
    const token = request.headers.get("x-goog-channel-token")?.trim();
    const state = request.headers.get("x-goog-resource-state")?.trim();
    const companyId = url.searchParams.get("company")?.trim();
    if (
      channelId &&
      token &&
      companyId &&
      state !== "sync" &&
      dependencies.requestDriveSync
    ) {
      const machine = driveMachinePrincipal(
        dependencies.machineConfiguration,
        companyId,
        sourceId
      );
      if (machine) {
        const matched = await matchesDriveNotificationChannel(
          dependencies.ingestPool,
          machine,
          {
            sourceId,
            channelId,
            tokenHash: createHash("sha256").update(token).digest("hex")
          }
        ).catch(() => false);
        if (matched)
          await dependencies
            .requestDriveSync({ companyId, sourceId, reason: "hint" })
            .catch(() => undefined);
      }
    }
    return noStore(null, 204);
  }

  if (url.pathname === "/v1/drive/sources" && request.method === "GET") {
    const identity = await verifyReader(request, dependencies);
    const sources = await listDriveEnrollments(dependencies.readPool, {
      companyId: identity.principal.companyId,
      actorId: identity.principal.actorId,
      callerId: identity.principal.callerId
    });
    return noStore({ sources }, 200);
  }

  const sync = url.pathname.match(/^\/v1\/drive\/([^/]+)\/sync$/);
  if (sync && request.method === "POST") {
    const sourceId = decodeURIComponent(sync[1] ?? "");
    const identity = await verifyReader(request, dependencies);
    const principal = identity.principal;
    // Only a source administrator may request a sync: the review role's
    // UPDATE policy on portal.source is the admin check, and the write it
    // performs is the audit mark of who asked.
    const admitted = await withPortalTransaction(
      dependencies.reviewPool,
      {
        companyId: principal.companyId,
        actorId: principal.actorId,
        callerId: principal.callerId
      },
      "write",
      async (client) =>
        (
          await client.query(
            `UPDATE portal.source SET "updatedBy"=$3,"updatedAt"=now(),version=version+1
             WHERE "companyId"=$1 AND id=$2 AND kind='drive' AND status='active'`,
            [principal.companyId, sourceId, principal.actorId]
          )
        ).rowCount === 1
    );
    if (!admitted) return noStore({ error: "forbidden" }, 403);
    if (!dependencies.requestDriveSync)
      return noStore({ error: "drive_sync_not_configured" }, 503);
    await dependencies.requestDriveSync({
      companyId: principal.companyId,
      sourceId,
      reason: "requested"
    });
    return noStore({ requested: true }, 202);
  }
  return null;
}
