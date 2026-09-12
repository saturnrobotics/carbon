import { now, parseAbsolute } from "@internationalized/date";
import type { Pool, PoolClient } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "../database.server";

export const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const DRIVE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
/** The only connector scope an enrollment may record (read-only). */
export const DRIVE_CONNECTOR_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
/** Bounds one persisted page and one descendant re-evaluation batch. */
export const DRIVE_PAGE_LIMIT = 1000;
export const DRIVE_DESCENDANT_LIMIT = 10_000;

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
  /**
   * False when the connector could not read this item's effective ACL. The
   * item is recorded but receives no grants, so it is excluded rather than
   * delivered on a stale or guessed permission set.
   */
  aclEvaluated?: boolean;
};
export type DriveChange = {
  cursor: string;
  kind: "upsert" | "delete" | "permission" | "move";
  document: DriveDocument;
};

export type DriveEnrollment = {
  sourceId: string;
  corpora: "drive" | "user";
  driveId: string | null;
  rootFolderIds: string[];
  oauthScope: string;
  userAccessScope: string;
  credentialSecretRef: string;
  domainWideDelegation: boolean;
  notificationChannelId: string | null;
  notificationTokenHash: string | null;
  reconcileAfterHours: number;
  reconciledAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: "succeeded" | "failed" | null;
  cursor: string;
};

export function isDriveFolder(document: Pick<DriveDocument, "mimeType">) {
  return document.mimeType === DRIVE_FOLDER_MIME_TYPE;
}
export function isDriveShortcut(
  document: Pick<DriveDocument, "mimeType" | "shortcutTargetId">
) {
  return (
    document.mimeType === DRIVE_SHORTCUT_MIME_TYPE ||
    !!document.shortcutTargetId
  );
}

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

/**
 * A shortcut is readable only by someone who can open both the shortcut and
 * its target, so its effective ACL is the intersection of the two principal
 * sets. Roles are taken from the target: that is what governs the bytes.
 */
export function intersectPermissions(
  shortcut: readonly DrivePermission[],
  target: readonly DrivePermission[]
): DrivePermission[] {
  const allowed = new Set(shortcut.map((entry) => entry.principalId));
  return target.filter((entry) => allowed.has(entry.principalId));
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

/**
 * Whether an item lies inside the enrolled scope: any item of the drive when
 * no root folders were enrolled, otherwise an item with an ancestor chain
 * reaching a root folder. The walk is cycle-safe and bounded to 64 levels.
 */
export function resolveDriveScope(
  document: Pick<DriveDocument, "id" | "parentIds" | "trashed">,
  rootFolderIds: readonly string[],
  ledger: ReadonlyMap<string, Pick<DriveDocument, "parentIds" | "trashed">>
): boolean {
  if (document.trashed) return false;
  if (!rootFolderIds.length) return true;
  const roots = new Set(rootFolderIds);
  if (roots.has(document.id)) return true;
  const seen = new Set<string>([document.id]);
  let frontier = document.parentIds;
  for (let depth = 0; depth < 64 && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const parentId of frontier) {
      if (roots.has(parentId)) return true;
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const parent = ledger.get(parentId);
      if (parent && !parent.trashed) next.push(...parent.parentIds);
    }
    frontier = next;
  }
  return false;
}

/**
 * Every ledger item below the given folders, transitively, plus every
 * shortcut whose target is one of them: the set whose ACL must be re-read
 * after a folder or shared-drive permission change.
 */
export function planDescendantInvalidation(
  changedIds: readonly string[],
  ledger: ReadonlyArray<
    Pick<DriveDocument, "id" | "parentIds" | "shortcutTargetId" | "trashed">
  >
): string[] {
  const changed = new Set(changedIds);
  const affected = new Set<string>();
  let frontier = [...changed];
  for (let depth = 0; depth < 64 && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const item of ledger) {
      if (item.trashed || affected.has(item.id) || changed.has(item.id))
        continue;
      if (
        item.parentIds.some((parentId) => frontier.includes(parentId)) ||
        (item.shortcutTargetId &&
          (frontier.includes(item.shortcutTargetId) ||
            affected.has(item.shortcutTargetId)))
      ) {
        affected.add(item.id);
        next.push(item.id);
      }
    }
    frontier = next;
  }
  return [...affected].sort((left, right) => left.localeCompare(right, "en"));
}

function permissionSignature(permissions: readonly DrivePermission[]): string {
  return JSON.stringify(
    [...permissions]
      .map((entry) => [
        entry.principalKind ?? "user",
        entry.principalId,
        entry.role
      ])
      .sort((left, right) =>
        left.join("|").localeCompare(right.join("|"), "en")
      )
  );
}

/**
 * Diff of a complete fresh listing against the recorded ledger. Items missing
 * from the listing are deleted; changed revisions are upserts; changed ACLs
 * are permission changes; changed parents are moves; the rest is silent, so a
 * repeated reconciliation of an unchanged drive persists nothing.
 */
export function reconcileDriveListing(
  cursor: string,
  listing: readonly DriveDocument[],
  ledger: readonly DriveDocument[]
): DriveChange[] {
  const known = new Map(ledger.map((item) => [item.id, item]));
  const changes: DriveChange[] = [];
  const seen = new Set<string>();
  for (const document of listing) {
    seen.add(document.id);
    const existing = known.get(document.id);
    if (document.trashed) {
      if (existing && !existing.trashed)
        changes.push({ cursor, kind: "delete", document });
      continue;
    }
    if (!existing || existing.trashed) {
      changes.push({ cursor, kind: "upsert", document });
      continue;
    }
    if (
      existing.revision !== document.revision ||
      existing.blobHash !== document.blobHash ||
      existing.shortcutTargetId !== document.shortcutTargetId ||
      existing.name !== document.name ||
      existing.mimeType !== document.mimeType
    )
      changes.push({ cursor, kind: "upsert", document });
    else if (
      permissionSignature(existing.permissions) !==
        permissionSignature(document.permissions) ||
      (existing.aclEvaluated ?? true) !== (document.aclEvaluated ?? true)
    )
      changes.push({ cursor, kind: "permission", document });
    else if (
      [...existing.parentIds].sort().join(",") !==
      [...document.parentIds].sort().join(",")
    )
      changes.push({ cursor, kind: "move", document });
  }
  for (const item of ledger) {
    if (!seen.has(item.id) && !item.trashed)
      changes.push({
        cursor,
        kind: "delete",
        document: { ...item, trashed: true }
      });
  }
  return changes;
}

/**
 * Whether a periodic full reconciliation is due: never reconciled, explicitly
 * requested, or older than the enrolled interval. Instants are compared as
 * zoned values, never through JavaScript `Date` arithmetic.
 */
export function driveReconciliationDue(
  enrollment: Pick<DriveEnrollment, "reconciledAt" | "reconcileAfterHours">,
  forced: boolean,
  nowIso: string = now("UTC").toAbsoluteString()
): boolean {
  if (forced || !enrollment.reconciledAt) return true;
  const due = parseAbsolute(enrollment.reconciledAt, "UTC").add({
    hours: enrollment.reconcileAfterHours
  });
  return parseAbsolute(nowIso, "UTC").compare(due) >= 0;
}

function driveChangePriority(change: DriveChange): number {
  if (change.kind === "delete" || change.document.trashed) return 0;
  if (change.kind === "permission" || change.kind === "move") return 1;
  return 2;
}

function recordCursor(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const pageToken = (value as Record<string, unknown>).pageToken;
  return typeof pageToken === "string" ? pageToken : "";
}

function requireMachine(principal: DatabasePrincipal) {
  if (principal.actorId)
    throw new Error("Drive synchronization requires a machine principal");
}

function toLedgerRow(change: DriveChange) {
  const document = change.document;
  const trashed = change.kind === "delete" || document.trashed;
  return {
    fileId: document.id,
    driveId: document.driveId || null,
    mimeType: document.mimeType ?? "application/octet-stream",
    name: (document.name ?? document.id).slice(0, 1024),
    parentIds: document.parentIds.slice(0, 64),
    shortcutTargetId: document.shortcutTargetId ?? null,
    revision: document.revision ?? null,
    contentHash: document.blobHash || null,
    trashed,
    aclEvaluated: trashed ? false : (document.aclEvaluated ?? true),
    permissions: trashed
      ? []
      : document.permissions
          .filter(
            (permission) =>
              permission.principalKind === undefined ||
              permission.principalKind === "user" ||
              permission.principalKind === "group"
          )
          .map((permission) => ({
            permissionId: permission.permissionId ?? null,
            principalKind: permission.principalKind ?? "user",
            principalId: permission.principalId,
            role: permission.role
          }))
  };
}

/**
 * One transaction per page: ledger, scope, documents, grants, outbox and the
 * cursor move together or not at all. Grants for every touched document are
 * revoked before the current ACL is re-inserted, and an item whose ACL could
 * not be evaluated receives none, so a failure can only narrow access.
 */
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
): Promise<{ upserted: number; withdrawn: number; aclChanged: number }> {
  requireMachine(principal);
  if (input.changes.length > DRIVE_PAGE_LIMIT)
    throw new Error("Drive change page exceeds the persistence bound");
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const source = await client.query<{ cursor: unknown }>(
      `SELECT cursor FROM knowledge.source WHERE "companyId"=$1 AND id=$2 AND kind='drive' AND status='active' FOR UPDATE`,
      [principal.companyId, input.sourceId]
    );
    const storedCursor = recordCursor(source.rows[0]?.cursor);
    if (!source.rows[0] || storedCursor !== input.expectedCursor)
      throw new Error("Drive cursor changed; restart from the stored cursor");
    const enrollment = await client.query<{ rootFolderIds: string[] }>(
      `SELECT "rootFolderIds" FROM knowledge."driveEnrollment" WHERE "companyId"=$1 AND "sourceId"=$2`,
      [principal.companyId, input.sourceId]
    );
    if (!enrollment.rows[0])
      throw new Error("Drive source has no enrollment record");
    const rootFolderIds = enrollment.rows[0].rootFolderIds;

    // One entry per file, the highest-priority kind winning: a delete of a
    // file never loses to an upsert of the same file elsewhere in the page.
    const byFile = new Map<string, DriveChange>();
    for (const change of [...input.changes].sort(
      (left, right) => driveChangePriority(left) - driveChangePriority(right)
    ))
      if (!byFile.has(change.document.id))
        byFile.set(change.document.id, change);
    const ordered = [...byFile.values()];
    const args = [
      principal.companyId,
      input.automationUserId,
      input.sourceId
    ] as const;
    if (ordered.length)
      await client.query(
        `INSERT INTO knowledge."driveItem" ("companyId","createdBy","sourceId","fileId","driveId","mimeType",name,"parentIds","shortcutTargetId",revision,"contentHash",trashed,"aclEvaluated",permissions,"observedAt","removedAt")
         SELECT $1,$2,$3,r."fileId",r."driveId",r."mimeType",r.name,COALESCE(r."parentIds",'{}'),r."shortcutTargetId",r.revision,r."contentHash",r.trashed,r."aclEvaluated",COALESCE(r.permissions,'[]'::jsonb),now(),CASE WHEN r.trashed THEN now() END
         FROM jsonb_to_recordset($4::jsonb) AS r("fileId" text,"driveId" text,"mimeType" text,name text,"parentIds" text[],"shortcutTargetId" text,revision text,"contentHash" text,trashed boolean,"aclEvaluated" boolean,permissions jsonb)
         ON CONFLICT ("companyId","sourceId","fileId") DO UPDATE SET
           "driveId"=EXCLUDED."driveId","mimeType"=EXCLUDED."mimeType",name=EXCLUDED.name,"parentIds"=EXCLUDED."parentIds",
           "shortcutTargetId"=EXCLUDED."shortcutTargetId",revision=EXCLUDED.revision,"contentHash"=EXCLUDED."contentHash",
           trashed=EXCLUDED.trashed,"aclEvaluated"=EXCLUDED."aclEvaluated",permissions=EXCLUDED.permissions,
           "observedAt"=now(),"removedAt"=CASE WHEN EXCLUDED.trashed THEN COALESCE("driveItem"."removedAt",now()) END,
           "updatedBy"=$2,"updatedAt"=now(),version="driveItem".version+1`,
        [...args, JSON.stringify(ordered.map(toLedgerRow))]
      );

    // Scope is recomputed for the whole source so a moved folder carries its
    // subtree with it. Only rows whose scope actually changed are written.
    const scopeChanges = await client.query<{
      fileId: string;
      inScope: boolean;
    }>(
      `WITH RECURSIVE reachable AS (
         SELECT i."fileId" FROM knowledge."driveItem" i
         WHERE i."companyId"=$1 AND i."sourceId"=$2 AND NOT i.trashed
           AND (cardinality($3::text[])=0 OR i."fileId"=ANY($3::text[]) OR i."parentIds" && $3::text[])
         UNION
         SELECT c."fileId" FROM knowledge."driveItem" c JOIN reachable r ON c."parentIds" && ARRAY[r."fileId"]
         WHERE c."companyId"=$1 AND c."sourceId"=$2 AND NOT c.trashed
       ), computed AS (
         SELECT i.id,i."fileId",(EXISTS (SELECT 1 FROM reachable r WHERE r."fileId"=i."fileId")) AS scoped
         FROM knowledge."driveItem" i WHERE i."companyId"=$1 AND i."sourceId"=$2
       )
       UPDATE knowledge."driveItem" i SET "inScope"=c.scoped,"updatedBy"=$4,"updatedAt"=now(),version=i.version+1
       FROM computed c WHERE i.id=c.id AND i."companyId"=$1 AND i."inScope" IS DISTINCT FROM c.scoped
       RETURNING i."fileId",i."inScope"`,
      [
        principal.companyId,
        input.sourceId,
        rootFolderIds,
        input.automationUserId
      ]
    );

    const pageIds = ordered.map((change) => change.document.id);
    const scopedIn = scopeChanges.rows
      .filter((row) => row.inScope)
      .map((row) => row.fileId);
    const scopedOut = scopeChanges.rows
      .filter((row) => !row.inScope)
      .map((row) => row.fileId);
    const candidateIds = [...new Set([...pageIds, ...scopedIn, ...scopedOut])];

    // The document set for this page is read back from the ledger, so page
    // entries and scope flips are treated identically.
    const items = await client.query<{
      fileId: string;
      name: string;
      mimeType: string;
      shortcutTargetId: string | null;
      revision: string | null;
      trashed: boolean;
      inScope: boolean;
      aclEvaluated: boolean;
      currentRevision: string | null;
      documentId: string | null;
      documentStatus: string | null;
    }>(
      `SELECT i."fileId",i.name,i."mimeType",i."shortcutTargetId",i.revision,i.trashed,i."inScope",i."aclEvaluated",
              v."sourceRevision" AS "currentRevision",d.id AS "documentId",d.status AS "documentStatus"
       FROM knowledge."driveItem" i
       LEFT JOIN knowledge.document d ON d."companyId"=i."companyId" AND d."sourceId"=i."sourceId" AND d."sourceItemId"=i."fileId"
       LEFT JOIN knowledge."documentVersion" v ON v."companyId"=d."companyId" AND v.id=d."currentVersionId"
       WHERE i."companyId"=$1 AND i."sourceId"=$2 AND i."fileId"=ANY($3::text[])`,
      [principal.companyId, input.sourceId, candidateIds]
    );
    const pageKinds = new Map(
      ordered.map((change) => [change.document.id, change.kind] as const)
    );
    const active = items.rows.filter(
      (item) =>
        item.inScope &&
        !item.trashed &&
        item.mimeType !== DRIVE_FOLDER_MIME_TYPE
    );
    const deleted = items.rows
      .filter(
        (item) =>
          item.documentId &&
          (item.trashed ||
            !item.inScope ||
            item.mimeType === DRIVE_FOLDER_MIME_TYPE)
      )
      .map((item) => item.fileId);
    let upserted = 0;
    if (active.length) {
      const inserted = await client.query(
        `INSERT INTO knowledge.document ("companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification)
         SELECT $1,$2,$3,d."sourceItemId",d.title,$2,'other','draft','source-restricted'
         FROM jsonb_to_recordset($4::jsonb) AS d("sourceItemId" text,title text)
         ON CONFLICT ("companyId","sourceId","sourceItemId") DO UPDATE SET title=EXCLUDED.title,"deletedAt"=NULL,
          status=CASE WHEN document.status='withdrawn' THEN CASE WHEN document."currentVersionId" IS NULL THEN 'draft' ELSE 'published' END ELSE document.status END,
          "updatedBy"=$2,"updatedAt"=now(),version=document.version+1
         WHERE document.title IS DISTINCT FROM EXCLUDED.title OR document."deletedAt" IS NOT NULL OR document.status='withdrawn'`,
        [
          ...args,
          JSON.stringify(
            active.map((item) => ({
              sourceItemId: item.fileId,
              title: item.name
            }))
          )
        ]
      );
      upserted = inserted.rowCount ?? 0;
    }
    let withdrawn = 0;
    if (deleted.length) {
      const result = await client.query(
        `UPDATE knowledge.document SET status='withdrawn',"deletedAt"=now(),"aclVersion"="aclVersion"+1,"updatedBy"=$2,"updatedAt"=now(),version=version+1
         WHERE "companyId"=$1 AND "sourceId"=$3 AND "sourceItemId"=ANY($4::text[]) AND "deletedAt" IS NULL`,
        [...args, deleted]
      );
      withdrawn = result.rowCount ?? 0;
    }

    const touched = [...active.map((item) => item.fileId), ...deleted];
    if (touched.length)
      await client.query(
        `UPDATE knowledge."grant" g SET "revokedAt"=now(),"updatedBy"=$2,"updatedAt"=now(),version=g.version+1
         FROM knowledge.document d WHERE g."companyId"=$1 AND g."sourceId"=$3 AND g."documentId"=d.id AND d."companyId"=g."companyId"
          AND d."sourceItemId"=ANY($4::text[]) AND g.origin='source' AND g."revokedAt" IS NULL`,
        [...args, touched]
      );
    const evaluated = active
      .filter((item) => item.aclEvaluated)
      .map((item) => item.fileId);
    if (evaluated.length)
      await client.query(
        `INSERT INTO knowledge."grant" ("companyId","createdBy","sourceId","documentId","subjectKind","subjectId",capability,origin,"sourcePermissionId","policyVersion")
         SELECT $1,$2,$3,d.id,p."principalKind",
           CASE WHEN p."principalKind"='user' THEN b."canonicalUserId" ELSE p."principalId" END,
           'read','source',p."permissionId",1
         FROM knowledge."driveItem" i
         CROSS JOIN LATERAL jsonb_to_recordset(i.permissions) AS p("principalKind" text,"principalId" text,"permissionId" text,role text)
         JOIN knowledge.document d ON d."companyId"=i."companyId" AND d."sourceId"=i."sourceId" AND d."sourceItemId"=i."fileId"
         LEFT JOIN knowledge."sourceUserBinding" b ON b."companyId"=$1 AND b."sourceId"=$3 AND b.active AND b."sourceUserId"=p."principalId"
         WHERE i."companyId"=$1 AND i."sourceId"=$3 AND i."fileId"=ANY($4::text[])
           AND p."principalKind" IN ('user','group')
           AND (p."principalKind"='group' OR b."canonicalUserId" IS NOT NULL)`,
        [...args, evaluated]
      );

    const events = [
      ...active.map((item) => {
        const kind = pageKinds.get(item.fileId);
        // A revived or newly scoped item is re-announced as an upsert so the
        // processor re-checks its content; the dedupe key re-arms a delivered
        // event of the same revision rather than duplicating it.
        const contentChanged =
          !kind ||
          kind === "upsert" ||
          item.documentStatus === "withdrawn" ||
          item.currentRevision !== item.revision;
        return {
          sourceItemId: item.fileId,
          sourceVersion: contentChanged
            ? (item.revision ?? input.nextCursor)
            : `${item.revision ?? ""}:acl:${input.nextCursor}`,
          eventType: contentChanged ? "upsert" : "acl-change",
          driveFileId: item.shortcutTargetId ?? item.fileId,
          mimeType: item.mimeType
        };
      }),
      ...deleted.map((fileId) => ({
        sourceItemId: fileId,
        sourceVersion: input.nextCursor,
        eventType: "delete",
        driveFileId: fileId,
        mimeType: null
      }))
    ];
    if (events.length)
      await client.query(
        `INSERT INTO knowledge.outbox ("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
         SELECT $1,$2,$3,'document',d.id,e."sourceVersion",e."eventType",jsonb_build_object('driveFileId',e."driveFileId",'documentId',d.id,'mimeType',e."mimeType")
         FROM jsonb_to_recordset($4::jsonb) AS e("sourceItemId" text,"sourceVersion" text,"eventType" text,"driveFileId" text,"mimeType" text)
         JOIN knowledge.document d ON d."companyId"=$1 AND d."sourceId"=$3 AND d."sourceItemId"=e."sourceItemId"
         ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO UPDATE
           SET "deliveredAt"=NULL,"availableAt"=now(),attempts=0,"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedBy"=$2,"updatedAt"=now(),version=outbox.version+1
           WHERE outbox."deliveredAt" IS NOT NULL`,
        [...args, JSON.stringify(events)]
      );
    const advanced = await client.query(
      `UPDATE knowledge.source SET cursor=jsonb_build_object('pageToken',$3::text),"updatedBy"=$2,"updatedAt"=now(),version=version+1
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
    return {
      upserted,
      withdrawn,
      aclChanged: events.filter((event) => event.eventType === "acl-change")
        .length
    };
  });
}

export async function getDriveSyncState(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string
): Promise<{ driveId: string; cursor: string }> {
  requireMachine(principal);
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

const enrollmentProjection = `e."sourceId",e.corpora,e."driveId",e."rootFolderIds",e."oauthScope",e."userAccessScope",e."credentialSecretRef",
  e."domainWideDelegation",e."notificationChannelId",e."notificationTokenHash",e."reconcileAfterHours",
  to_char(e."reconciledAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "reconciledAt",
  to_char(e."lastSyncAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastSyncAt",
  e."lastSyncStatus",COALESCE(s.cursor->>'pageToken','') AS cursor`;

function readEnrollment(
  client: PoolClient,
  companyId: string,
  sourceId: string
) {
  return client.query<DriveEnrollment>(
    `SELECT ${enrollmentProjection} FROM knowledge."driveEnrollment" e
     JOIN knowledge.source s ON s."companyId"=e."companyId" AND s.id=e."sourceId" AND s.kind='drive' AND s.status='active'
     WHERE e."companyId"=$1 AND e."sourceId"=$2`,
    [companyId, sourceId]
  );
}

/** The enrollment as the sync worker sees it; refuses a delegation-wide credential. */
export async function getDriveEnrollment(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string
): Promise<DriveEnrollment> {
  requireMachine(principal);
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const enrollment = (
      await readEnrollment(client, principal.companyId, sourceId)
    ).rows[0];
    if (!enrollment)
      throw new Error("Drive source is not enrolled for this worker");
    if (enrollment.domainWideDelegation)
      throw new Error(
        "Domain-wide delegation is not an enrolled connector credential"
      );
    if (enrollment.oauthScope !== DRIVE_CONNECTOR_SCOPE)
      throw new Error("Drive enrollment scope is not read-only");
    return enrollment;
  });
}

export type DriveEnrollmentSummary = {
  sourceId: string;
  displayName: string;
  ownerId: string;
  classification: string;
  corpora: "drive" | "user";
  driveId: string | null;
  rootFolderIds: string[];
  oauthScope: string;
  userAccessScope: string;
  domainWideDelegation: boolean;
  providerPolicy: Record<string, unknown>;
  reconcileAfterHours: number;
  reconciledAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: "succeeded" | "failed" | null;
  documentCount: number;
};

/**
 * What the portal shows a reader about the Drive sources they can see: the
 * recorded scope, owner, admitted corpora and provider eligibility. The
 * credential reference and notification secret never leave the database.
 */
export async function listDriveEnrollments(
  pool: Pool,
  principal: DatabasePrincipal
): Promise<DriveEnrollmentSummary[]> {
  if (!principal.actorId)
    throw new Error("Drive enrollment listing requires a human principal");
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<
      Omit<DriveEnrollmentSummary, "documentCount"> & { documentCount: string }
    >(
      `SELECT e."sourceId",s."displayName",s."ownerId",s.classification,e.corpora,e."driveId",e."rootFolderIds",
         e."oauthScope",e."userAccessScope",e."domainWideDelegation",s."providerPolicy",e."reconcileAfterHours",
         to_char(e."reconciledAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "reconciledAt",
         to_char(e."lastSyncAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastSyncAt",
         e."lastSyncStatus",
         (SELECT count(*) FROM knowledge.document d WHERE d."companyId"=e."companyId" AND d."sourceId"=e."sourceId" AND d.status='published' AND d."deletedAt" IS NULL)::text AS "documentCount"
       FROM knowledge."driveEnrollment" e
       JOIN knowledge.source s ON s."companyId"=e."companyId" AND s.id=e."sourceId" AND s.kind='drive'
       WHERE e."companyId"=$1 ORDER BY s."displayName",e."sourceId" LIMIT 50`,
      [principal.companyId]
    );
    return result.rows.map((row) => ({
      ...row,
      documentCount: Number(row.documentCount)
    }));
  });
}

export async function recordDriveSyncOutcome(
  pool: Pool,
  principal: DatabasePrincipal,
  input: {
    sourceId: string;
    automationUserId: string;
    status: "succeeded" | "failed";
    reconciled?: boolean;
    error?: string;
  }
): Promise<void> {
  requireMachine(principal);
  await withKnowledgeTransaction(pool, principal, "write", async (client) => {
    const result = await client.query(
      `UPDATE knowledge."driveEnrollment" SET "lastSyncAt"=now(),"lastSyncStatus"=$3,"lastSyncError"=$4,
         "reconciledAt"=CASE WHEN $5::boolean THEN now() ELSE "reconciledAt" END,
         "updatedBy"=$6,"updatedAt"=now(),version=version+1
       WHERE "companyId"=$1 AND "sourceId"=$2`,
      [
        principal.companyId,
        input.sourceId,
        input.status,
        input.status === "failed"
          ? (input.error ?? "sync failed").slice(0, 500)
          : null,
        input.status === "succeeded" && !!input.reconciled,
        input.automationUserId
      ]
    );
    if (result.rowCount !== 1)
      throw new Error("Drive enrollment is not writable by this worker");
  });
}

function toDriveDocument(row: {
  fileId: string;
  driveId: string | null;
  mimeType: string;
  name: string;
  parentIds: string[];
  shortcutTargetId: string | null;
  revision: string | null;
  contentHash: string | null;
  trashed: boolean;
  aclEvaluated: boolean;
  permissions: unknown;
}): DriveDocument {
  const permissions = Array.isArray(row.permissions)
    ? (row.permissions as Array<Record<string, unknown>>).flatMap((entry) => {
        const principalId = entry.principalId;
        const role = entry.role;
        if (
          typeof principalId !== "string" ||
          (role !== "reader" && role !== "writer" && role !== "owner")
        )
          return [];
        const kind = entry.principalKind;
        const permission: DrivePermission = {
          principalId,
          role,
          principalKind: kind === "group" ? "group" : "user"
        };
        return [
          {
            ...permission,
            ...(typeof entry.permissionId === "string"
              ? { permissionId: entry.permissionId }
              : {})
          }
        ];
      })
    : [];
  return {
    id: row.fileId,
    driveId: row.driveId ?? "",
    parentIds: row.parentIds,
    blobHash: row.contentHash ?? "",
    trashed: row.trashed,
    permissions,
    name: row.name,
    mimeType: row.mimeType,
    revision: row.revision ?? undefined,
    shortcutTargetId: row.shortcutTargetId ?? undefined,
    aclEvaluated: row.aclEvaluated
  };
}

const ledgerProjection = `"fileId","driveId","mimeType",name,"parentIds","shortcutTargetId",revision,"contentHash",trashed,"aclEvaluated",permissions`;

/** Ledger rows by file id (at most 1000 per call), for change classification. */
export async function listDriveItems(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string,
  fileIds: readonly string[]
): Promise<DriveDocument[]> {
  requireMachine(principal);
  if (!fileIds.length) return [];
  if (fileIds.length > DRIVE_PAGE_LIMIT)
    throw new Error("Drive ledger lookup exceeds the page bound");
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query(
      `SELECT ${ledgerProjection} FROM knowledge."driveItem" WHERE "companyId"=$1 AND "sourceId"=$2 AND "fileId"=ANY($3::text[])`,
      [principal.companyId, sourceId, [...new Set(fileIds)]]
    );
    return result.rows.map(toDriveDocument);
  });
}

/** Every non-trashed ledger row of a source, for reconciliation (bounded). */
export async function listDriveLedger(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string
): Promise<DriveDocument[]> {
  requireMachine(principal);
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query(
      `SELECT ${ledgerProjection} FROM knowledge."driveItem" WHERE "companyId"=$1 AND "sourceId"=$2 AND NOT trashed ORDER BY "fileId" LIMIT ${DRIVE_DESCENDANT_LIMIT + 1}`,
      [principal.companyId, sourceId]
    );
    if (result.rows.length > DRIVE_DESCENDANT_LIMIT)
      throw new Error("Drive ledger exceeds the reconciliation bound");
    return result.rows.map(toDriveDocument);
  });
}

/**
 * File ids below the given folders plus shortcuts targeting any of them,
 * transitively, from the ledger. The set a folder or shared-drive
 * permission change must re-read from Drive.
 */
export async function listDriveDescendants(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string,
  changedIds: readonly string[]
): Promise<string[]> {
  requireMachine(principal);
  if (!changedIds.length) return [];
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<{ fileId: string }>(
      `WITH RECURSIVE affected AS (
         SELECT i."fileId",1 AS depth FROM knowledge."driveItem" i
         WHERE i."companyId"=$1 AND i."sourceId"=$2 AND NOT i.trashed
           AND (i."parentIds" && $3::text[] OR i."shortcutTargetId"=ANY($3::text[]))
         UNION
         SELECT c."fileId",a.depth+1 FROM knowledge."driveItem" c JOIN affected a
           ON (c."parentIds" && ARRAY[a."fileId"] OR c."shortcutTargetId"=a."fileId")
         WHERE c."companyId"=$1 AND c."sourceId"=$2 AND NOT c.trashed AND a.depth<64
       ) SELECT DISTINCT "fileId" FROM affected WHERE NOT ("fileId"=ANY($3::text[])) ORDER BY 1 LIMIT ${DRIVE_DESCENDANT_LIMIT + 1}`,
      [principal.companyId, sourceId, [...new Set(changedIds)]]
    );
    if (result.rows.length > DRIVE_DESCENDANT_LIMIT)
      throw new Error("Drive descendant set exceeds the re-evaluation bound");
    return result.rows.map((row) => row.fileId);
  });
}

/** In-scope, ACL-evaluated ledger entries whose document a reader may be served. */
export async function getDriveItemForAccess(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string,
  fileId: string
): Promise<{ fileId: string; shortcutTargetId: string | null } | null> {
  requireMachine(principal);
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<{
      fileId: string;
      shortcutTargetId: string | null;
    }>(
      `SELECT "fileId","shortcutTargetId" FROM knowledge."driveItem"
       WHERE "companyId"=$1 AND "sourceId"=$2 AND "fileId"=$3 AND NOT trashed AND "inScope" AND "aclEvaluated"`,
      [principal.companyId, sourceId, fileId]
    );
    return result.rows[0] ?? null;
  });
}

/**
 * Verifies a push-notification hint against the enrolled channel. The hint
 * carries no data the connector acts on; a valid one only schedules the
 * cursor-based sync that would have run anyway.
 */
export async function matchesDriveNotificationChannel(
  pool: Pool,
  principal: DatabasePrincipal,
  input: { sourceId: string; channelId: string; tokenHash: string }
): Promise<boolean> {
  requireMachine(principal);
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query(
      `SELECT 1 FROM knowledge."driveEnrollment"
       WHERE "companyId"=$1 AND "sourceId"=$2 AND "notificationChannelId"=$3 AND "notificationTokenHash"=$4`,
      [principal.companyId, input.sourceId, input.channelId, input.tokenHash]
    );
    return result.rows.length === 1;
  });
}
