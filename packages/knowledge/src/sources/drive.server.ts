import type { Pool } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "../database.server";

export type DrivePermission = {
  permissionId?: string;
  principalId: string;
  principalKind?: "user" | "group" | "domain" | "anyone";
  role: "reader" | "writer" | "owner";
  inheritedFrom?: string;
};
export type DriveDocument = {
  id: string;
  driveId: string;
  parentIds: string[];
  blobHash: string;
  trashed: boolean;
  permissions: DrivePermission[];
  name?: string;
  mimeType?: string;
  revision?: string;
  shortcutTargetId?: string;
};
export type DriveChange = {
  cursor: string;
  kind: "upsert" | "delete" | "permission" | "move";
  document: DriveDocument;
};

export function effectivePermissions(
  document: DriveDocument,
  inherited: readonly DrivePermission[]
): DrivePermission[] {
  if (document.trashed) return [];
  const entries = [...inherited, ...document.permissions];
  return [
    ...new Map(entries.map((entry) => [entry.principalId, entry])).values()
  ];
}

/** A shared blob never carries authorization from a different Drive source. */
export async function canDeliverDriveDocument(
  document: DriveDocument,
  userId: string,
  inherited: readonly DrivePermission[],
  liveCheck?: (documentId: string, principalId: string) => Promise<boolean>
): Promise<boolean> {
  if (!liveCheck) return false;
  const permitted = effectivePermissions(document, inherited).some(
    (entry) =>
      (entry.principalKind === undefined || entry.principalKind === "user") &&
      entry.principalId === userId
  );
  return permitted && (await liveCheck(document.id, userId));
}

export function applyDriveChanges(
  currentCursor: string | undefined,
  changes: readonly DriveChange[]
): {
  cursor: string | undefined;
  upserts: DriveDocument[];
  tombstones: string[];
  aclChanged: string[];
} {
  const upserts: DriveDocument[] = [];
  const tombstones: string[] = [];
  const aclChanged: string[] = [];
  let cursor = currentCursor;
  for (const change of changes) {
    cursor = change.cursor;
    if (change.kind === "delete" || change.document.trashed)
      tombstones.push(change.document.id);
    else if (change.kind === "permission" || change.kind === "move")
      aclChanged.push(change.document.id);
    else upserts.push(change.document);
  }
  return { cursor, upserts, tombstones, aclChanged };
}

export async function persistDriveChangePage(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    sourceId: string;
    automationUserId: string;
    expectedCursor: string;
    nextCursor: string;
    changes: readonly DriveChange[];
  }
): Promise<void> {
  if (principal.actorId)
    throw new Error("Drive synchronization requires a machine principal");
  await withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const source = await client.query<{ cursor: unknown }>(
      `SELECT cursor FROM knowledge.source WHERE "companyId"=$1 AND id=$2 AND kind='drive' AND status='active' FOR UPDATE`,
      [principal.companyId, input.sourceId]
    );
    const storedCursor = recordCursor(source.rows[0]?.cursor);
    if (!source.rows[0] || storedCursor !== input.expectedCursor)
      throw new Error("Drive cursor changed; restart from the stored cursor");

    const ordered = [...input.changes].sort(
      (left, right) => driveChangePriority(left) - driveChangePriority(right)
    );
    const active = ordered
      .filter((change) => change.kind !== "delete" && !change.document.trashed)
      .map((change) => ({
        sourceItemId: change.document.id,
        title: change.document.name ?? change.document.id
      }));
    const deleted = ordered
      .filter((change) => change.kind === "delete" || change.document.trashed)
      .map((change) => change.document.id);
    if (active.length)
      await client.query(
        `INSERT INTO knowledge.document ("companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification)
       SELECT $1,$2,$3,d."sourceItemId",d.title,$2,'other','draft','source-restricted'
       FROM jsonb_to_recordset($4::jsonb) AS d("sourceItemId" text,title text)
       ON CONFLICT ("companyId","sourceId","sourceItemId") DO UPDATE SET title=EXCLUDED.title,"deletedAt"=NULL,
        status=CASE WHEN document.status='withdrawn' THEN 'draft' ELSE document.status END,"updatedBy"=$2,"updatedAt"=now(),version=document.version+1
       WHERE document.title IS DISTINCT FROM EXCLUDED.title OR document."deletedAt" IS NOT NULL OR document.status='withdrawn'`,
        [
          principal.companyId,
          input.automationUserId,
          input.sourceId,
          JSON.stringify(active)
        ]
      );
    if (deleted.length)
      await client.query(
        `UPDATE knowledge.document SET status='withdrawn',"deletedAt"=now(),"aclVersion"="aclVersion"+1,"updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND "sourceId"=$3 AND "sourceItemId"=ANY($4::text[]) AND "deletedAt" IS NULL`,
        [principal.companyId, input.automationUserId, input.sourceId, deleted]
      );

    const aclItems = active.map((item) => item.sourceItemId);
    if (aclItems.length)
      await client.query(
        `UPDATE knowledge."grant" g SET "revokedAt"=now(),"updatedBy"=$2,"updatedAt"=now(),version=g.version+1
       FROM knowledge.document d WHERE g."companyId"=$1 AND g."sourceId"=$3 AND g."documentId"=d.id AND d."companyId"=g."companyId"
        AND d."sourceItemId"=ANY($4::text[]) AND g.origin='source' AND g."revokedAt" IS NULL`,
        [principal.companyId, input.automationUserId, input.sourceId, aclItems]
      );
    const permissionRows = ordered.flatMap((change) =>
      change.kind === "delete" || change.document.trashed
        ? []
        : change.document.permissions.flatMap((permission) => {
            if (
              permission.principalKind !== "user" &&
              permission.principalKind !== "group" &&
              permission.principalKind !== undefined
            )
              return [];
            return [
              {
                sourceItemId: change.document.id,
                subjectKind: permission.principalKind ?? "user",
                sourceSubjectId: permission.principalId,
                sourcePermissionId: permission.permissionId ?? null
              }
            ];
          })
    );
    if (permissionRows.length)
      await client.query(
        `INSERT INTO knowledge."grant" ("companyId","createdBy","sourceId","documentId","subjectKind","subjectId",capability,origin,"sourcePermissionId","policyVersion")
       SELECT $1,$2,$3,d.id,p."subjectKind",CASE WHEN p."subjectKind"='user' THEN b."canonicalUserId" ELSE p."sourceSubjectId" END,'read','source',p."sourcePermissionId",1
       FROM jsonb_to_recordset($4::jsonb) AS p("sourceItemId" text,"subjectKind" text,"sourceSubjectId" text,"sourcePermissionId" text)
       JOIN knowledge.document d ON d."companyId"=$1 AND d."sourceId"=$3 AND d."sourceItemId"=p."sourceItemId"
       LEFT JOIN knowledge."sourceUserBinding" b ON b."companyId"=$1 AND b."sourceId"=$3 AND b.active AND b."sourceUserId"=p."sourceSubjectId"
       WHERE p."subjectKind"='group' OR b."canonicalUserId" IS NOT NULL`,
        [
          principal.companyId,
          input.automationUserId,
          input.sourceId,
          JSON.stringify(permissionRows)
        ]
      );
    const events = ordered.map((change) => ({
      sourceItemId: change.document.id,
      sourceVersion: change.document.revision ?? change.cursor,
      eventType:
        change.kind === "delete" || change.document.trashed
          ? "delete"
          : change.kind === "permission" || change.kind === "move"
            ? "acl-change"
            : "upsert",
      mimeType: change.document.mimeType ?? null
    }));
    if (events.length)
      await client.query(
        `INSERT INTO knowledge.outbox ("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
       SELECT $1,$2,$3,'document',d.id,e."sourceVersion",e."eventType",jsonb_build_object('driveFileId',e."sourceItemId",'documentId',d.id,'mimeType',e."mimeType")
       FROM jsonb_to_recordset($4::jsonb) AS e("sourceItemId" text,"sourceVersion" text,"eventType" text,"mimeType" text)
       JOIN knowledge.document d ON d."companyId"=$1 AND d."sourceId"=$3 AND d."sourceItemId"=e."sourceItemId"
       ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO NOTHING`,
        [
          principal.companyId,
          input.automationUserId,
          input.sourceId,
          JSON.stringify(events)
        ]
      );
    const advanced = await client.query(
      `UPDATE knowledge.source SET cursor=jsonb_build_object('pageToken',$3),"updatedBy"=$2,"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND id=$4 AND COALESCE(cursor->>'pageToken','')=$5`,
      [
        principal.companyId,
        input.automationUserId,
        input.nextCursor,
        input.sourceId,
        input.expectedCursor
      ]
    );
    if (advanced.rowCount !== 1)
      throw new Error("Drive cursor changed before the page committed");
  });
}

function recordCursor(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const pageToken = (value as Record<string, unknown>).pageToken;
  return typeof pageToken === "string" ? pageToken : "";
}

export async function getDriveSyncState(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string
): Promise<{ driveId: string; cursor: string }> {
  if (principal.actorId)
    throw new Error("Drive synchronization requires a machine principal");
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<{ externalId: string; cursor: unknown }>(
      `SELECT "externalId" AS "externalId",cursor FROM knowledge.source WHERE "companyId"=$1 AND id=$2 AND kind='drive' AND status='active'`,
      [principal.companyId, sourceId]
    );
    const source = result.rows[0];
    if (!source)
      throw new Error("Drive source is not available to this worker");
    return { driveId: source.externalId, cursor: recordCursor(source.cursor) };
  });
}

function driveChangePriority(change: DriveChange): number {
  if (change.kind === "delete" || change.document.trashed) return 0;
  if (change.kind === "permission" || change.kind === "move") return 1;
  return 2;
}
