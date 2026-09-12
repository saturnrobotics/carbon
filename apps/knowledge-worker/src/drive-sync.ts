import type { DatabasePrincipal } from "@carbon/knowledge/database.server";
import {
  type DriveChange,
  type DriveDocument,
  type DriveEnrollment,
  driveReconciliationDue,
  getDriveEnrollment,
  intersectPermissions,
  isDriveFolder,
  isDriveShortcut,
  listDriveDescendants,
  listDriveItems,
  listDriveLedger,
  persistDriveChangePage,
  reconcileDriveListing,
  recordDriveSyncOutcome
} from "@carbon/knowledge/sources/drive.server";
import type { Pool } from "pg";
import {
  chunk,
  DRIVE_BATCH_LIMIT,
  type DriveApiClient,
  type GoogleChange,
  type GoogleFile,
  googleFileToDocument
} from "./drive-client";
import { knowledgeInngest } from "./inngest";

export type DriveSyncReason = "scheduled" | "hint" | "requested" | "reconcile";
export type DriveSyncPage = {
  expectedCursor: string;
  nextCursor: string;
  changes: DriveChange[];
};
export type DriveLedger = {
  items(fileIds: readonly string[]): Promise<DriveDocument[]>;
  all(): Promise<DriveDocument[]>;
  descendants(changedIds: readonly string[]): Promise<string[]>;
};
export type DriveSyncDependencies = {
  client: DriveApiClient;
  enrollment: Pick<
    DriveEnrollment,
    | "driveId"
    | "rootFolderIds"
    | "cursor"
    | "reconciledAt"
    | "reconcileAfterHours"
  >;
  ledger: DriveLedger;
  persistPage(page: DriveSyncPage): Promise<unknown>;
  /** Bounds one run; the remainder continues in a follow-up run. */
  maxPages?: number;
  nowIso?: () => string;
};
export type DriveSyncResult = {
  mode: "initial" | "incremental";
  cursor: string;
  pages: number;
  changes: number;
  reconciled: boolean;
  complete: boolean;
};

const PERSIST_CHUNK = 500;

/** A tombstone for a file the connector can no longer describe. */
function tombstone(fileId: string, driveId: string): DriveDocument {
  return {
    id: fileId,
    driveId,
    parentIds: [],
    blobHash: "",
    trashed: true,
    permissions: [],
    aclEvaluated: false
  };
}

/**
 * Resolves a page of Drive files into connector documents: effective ACLs
 * are read in one batch, shortcut targets in another, and a shortcut's ACL
 * becomes the intersection of its own and its target's. A target the
 * connector cannot read makes the shortcut disappear; an ACL it cannot read
 * leaves the item recorded but ungranted.
 */
export async function resolveDriveFiles(
  client: DriveApiClient,
  driveId: string,
  files: readonly GoogleFile[]
): Promise<DriveDocument[]> {
  const live = files.filter((file) => !file.trashed);
  const shortcuts = live.filter(
    (file) =>
      isDriveShortcut({
        mimeType: file.mimeType,
        shortcutTargetId: file.shortcutDetails?.targetId
      }) && file.shortcutDetails?.targetId
  );
  const targetIds = shortcuts.map((file) => file.shortcutDetails!.targetId!);
  const targets = targetIds.length
    ? await client.getFiles(targetIds)
    : new Map<string, GoogleFile | null>();
  const readableTargetIds = [...targets.entries()]
    .filter(([, file]) => file && !file.trashed)
    .map(([id]) => id);
  const permissionIds = [
    ...new Set([...live.map((file) => file.id), ...readableTargetIds])
  ];
  const permissions = permissionIds.length
    ? await client.listPermissions(permissionIds)
    : new Map();
  return files.map((file) => {
    if (file.trashed) return googleFileToDocument(file, driveId, null);
    const own = googleFileToDocument(
      file,
      driveId,
      permissions.get(file.id) ?? null
    );
    const targetId = own.shortcutTargetId;
    if (!targetId) return own;
    const target = targets.get(targetId);
    if (!target || target.trashed) return { ...own, trashed: true };
    const resolvedTarget = googleFileToDocument(
      target,
      driveId,
      permissions.get(targetId) ?? null
    );
    return {
      ...own,
      blobHash: resolvedTarget.blobHash,
      revision: `${own.revision ?? ""}:${resolvedTarget.revision ?? ""}`,
      mimeType: target.mimeType,
      shortcutTargetId: targetId,
      aclEvaluated: !!own.aclEvaluated && !!resolvedTarget.aclEvaluated,
      permissions:
        own.aclEvaluated && resolvedTarget.aclEvaluated
          ? intersectPermissions(own.permissions, resolvedTarget.permissions)
          : []
    };
  });
}

/** Walks the enrolled scope: every file of the drive, or each root folder's subtree. */
async function listScopedFiles(
  client: DriveApiClient,
  enrollment: DriveSyncDependencies["enrollment"],
  maxPages: number
): Promise<{ files: GoogleFile[]; complete: boolean }> {
  const files = new Map<string, GoogleFile>();
  let pages = 0;
  const walk = async (parentId?: string) => {
    let pageToken: string | undefined;
    do {
      if (pages >= maxPages) return false;
      const page = await client.listFiles({
        driveId: enrollment.driveId,
        parentId,
        pageToken
      });
      pages += 1;
      for (const file of page.files ?? []) files.set(file.id, file);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return true;
  };
  if (!enrollment.rootFolderIds.length) {
    const complete = await walk();
    return { files: [...files.values()], complete };
  }
  // Folder scope: breadth-first over subfolders, cycle-safe.
  const queue = [...enrollment.rootFolderIds];
  const seen = new Set<string>();
  while (queue.length) {
    const folderId = queue.shift()!;
    if (seen.has(folderId)) continue;
    seen.add(folderId);
    if (!(await walk(folderId)))
      return { files: [...files.values()], complete: false };
    for (const file of files.values())
      if (
        isDriveFolder({ mimeType: file.mimeType }) &&
        !seen.has(file.id) &&
        file.parents?.includes(folderId)
      )
        queue.push(file.id);
  }
  return { files: [...files.values()], complete: true };
}

async function persistInChunks(
  dependencies: DriveSyncDependencies,
  cursor: string,
  changes: readonly DriveChange[]
): Promise<number> {
  let pages = 0;
  for (const group of chunk(changes, PERSIST_CHUNK)) {
    await dependencies.persistPage({
      expectedCursor: cursor,
      nextCursor: cursor,
      changes: group
    });
    pages += 1;
  }
  return pages;
}

/**
 * A full listing diffed against the ledger and persisted without moving the
 * cursor. Used for the first load (behind a start token taken beforehand, so
 * concurrent edits replay through changes.list) and for periodic recovery.
 */
async function reconcileFromListing(
  dependencies: DriveSyncDependencies,
  cursor: string,
  maxPages: number
): Promise<{ changes: number; pages: number; complete: boolean }> {
  const listing = await listScopedFiles(
    dependencies.client,
    dependencies.enrollment,
    maxPages
  );
  if (!listing.complete) return { changes: 0, pages: 0, complete: false };
  const driveId = dependencies.enrollment.driveId ?? "";
  const resolved: DriveDocument[] = [];
  for (const group of chunk(listing.files, DRIVE_BATCH_LIMIT))
    resolved.push(
      ...(await resolveDriveFiles(dependencies.client, driveId, group))
    );
  const changes = reconcileDriveListing(
    cursor,
    resolved,
    await dependencies.ledger.all()
  );
  const pages = await persistInChunks(dependencies, cursor, changes);
  return { changes: changes.length, pages, complete: true };
}

/**
 * Classifies one changes.list page. Folder and shared-drive permission or
 * placement changes fan out to every recorded descendant, whose ACL is
 * re-read from Drive rather than inferred.
 */
export async function classifyChangePage(
  dependencies: Pick<DriveSyncDependencies, "client" | "ledger" | "enrollment">,
  cursor: string,
  rawChanges: readonly GoogleChange[]
): Promise<{ changes: DriveChange[]; descendants: DriveChange[] }> {
  const driveId = dependencies.enrollment.driveId ?? "";
  const driveRemoved = rawChanges.some(
    (change) =>
      change.changeType === "drive" &&
      change.removed &&
      (!driveId || change.driveId === driveId || change.drive?.id === driveId)
  );
  if (driveRemoved) {
    const everything = await dependencies.ledger.all();
    return {
      changes: everything.map((item) => ({
        cursor,
        kind: "delete",
        document: { ...item, trashed: true }
      })),
      descendants: []
    };
  }
  const fileChanges = rawChanges.filter(
    (change) => change.changeType !== "drive" && change.fileId
  );
  const known = new Map(
    (
      await dependencies.ledger.items(
        fileChanges.map((change) => change.fileId!)
      )
    ).map((item) => [item.id, item])
  );
  const present = fileChanges
    .filter((change) => change.file && !change.removed)
    .map((change) => change.file!);
  const resolved = new Map(
    (await resolveDriveFiles(dependencies.client, driveId, present)).map(
      (document) => [document.id, document]
    )
  );
  const changes: DriveChange[] = [];
  const reevaluate: string[] = [];
  for (const change of fileChanges) {
    const fileId = change.fileId!;
    const existing = known.get(fileId);
    const document = resolved.get(fileId);
    if (change.removed || !document || document.trashed) {
      changes.push({
        cursor,
        kind: "delete",
        document: existing
          ? { ...existing, trashed: true }
          : (document ?? tombstone(fileId, driveId))
      });
      if (existing && isDriveFolder(existing)) reevaluate.push(fileId);
      continue;
    }
    const permissionChanged =
      existing &&
      JSON.stringify(existing.permissions) !==
        JSON.stringify(document.permissions);
    const moved =
      existing &&
      [...existing.parentIds].sort().join(",") !==
        [...document.parentIds].sort().join(",");
    const contentChanged =
      !existing ||
      existing.revision !== document.revision ||
      existing.blobHash !== document.blobHash ||
      existing.shortcutTargetId !== document.shortcutTargetId;
    changes.push({
      cursor,
      kind: contentChanged
        ? "upsert"
        : permissionChanged
          ? "permission"
          : moved
            ? "move"
            : "upsert",
      document
    });
    if (isDriveFolder(document) && (permissionChanged || moved || !existing))
      reevaluate.push(fileId);
    else if (!isDriveFolder(document) && permissionChanged)
      reevaluate.push(fileId); // shortcuts targeting this file
  }
  const driveChanged = rawChanges.some(
    (change) => change.changeType === "drive" && !change.removed
  );
  const descendantIds = driveChanged
    ? (await dependencies.ledger.all()).map((item) => item.id)
    : await dependencies.ledger.descendants(reevaluate);
  const pageIds = new Set(changes.map((change) => change.document.id));
  const toReread = descendantIds.filter((id) => !pageIds.has(id));
  const descendants: DriveChange[] = [];
  if (toReread.length) {
    const ledgerItems = new Map(
      (await dependencies.ledger.items(toReread)).map((item) => [item.id, item])
    );
    for (const group of chunk(toReread, DRIVE_BATCH_LIMIT)) {
      const files = await dependencies.client.getFiles(group);
      const readable = group.flatMap((id) => {
        const file = files.get(id);
        return file ? [file] : [];
      });
      const documents = new Map(
        (await resolveDriveFiles(dependencies.client, driveId, readable)).map(
          (document) => [document.id, document]
        )
      );
      for (const id of group) {
        const document = documents.get(id);
        const existing = ledgerItems.get(id) ?? tombstone(id, driveId);
        descendants.push(
          !document || document.trashed
            ? {
                cursor,
                kind: "delete",
                document: { ...existing, trashed: true }
              }
            : { cursor, kind: "permission", document }
        );
      }
    }
  }
  return { changes, descendants };
}

/**
 * One sync run. The cursor is the only recovery state: an interrupted first
 * load restarts from its listing (upserts are idempotent), an interrupted
 * incremental run resumes at the last committed page token, and the
 * reconciliation listing never moves the cursor at all.
 */
export async function runDriveSync(
  dependencies: DriveSyncDependencies,
  reason: DriveSyncReason = "scheduled"
): Promise<DriveSyncResult> {
  const maxPages = dependencies.maxPages ?? 50;
  let cursor = dependencies.enrollment.cursor;
  if (!cursor) {
    const startToken = await dependencies.client.getStartPageToken(
      dependencies.enrollment.driveId
    );
    const listing = await reconcileFromListing(dependencies, cursor, maxPages);
    if (!listing.complete)
      return {
        mode: "initial",
        cursor,
        pages: 0,
        changes: 0,
        reconciled: false,
        complete: false
      };
    await dependencies.persistPage({
      expectedCursor: cursor,
      nextCursor: startToken,
      changes: []
    });
    return {
      mode: "initial",
      cursor: startToken,
      pages: listing.pages + 1,
      changes: listing.changes,
      reconciled: true,
      complete: true
    };
  }
  let pages = 0;
  let changes = 0;
  let complete = false;
  while (pages < maxPages) {
    const page = await dependencies.client.listChanges(
      cursor,
      dependencies.enrollment.driveId
    );
    const classified = await classifyChangePage(
      dependencies,
      cursor,
      page.changes ?? []
    );
    // Descendant re-evaluations commit under the current cursor first, so a
    // crash between them and the page itself only repeats work.
    pages += await persistInChunks(
      dependencies,
      cursor,
      classified.descendants
    );
    const nextCursor = page.nextPageToken ?? page.newStartPageToken ?? cursor;
    await dependencies.persistPage({
      expectedCursor: cursor,
      nextCursor,
      changes: classified.changes
    });
    pages += 1;
    changes += classified.changes.length + classified.descendants.length;
    cursor = nextCursor;
    if (!page.nextPageToken) {
      complete = true;
      break;
    }
  }
  if (!complete)
    return {
      mode: "incremental",
      cursor,
      pages,
      changes,
      reconciled: false,
      complete: false
    };
  let reconciled = false;
  if (
    driveReconciliationDue(
      dependencies.enrollment,
      reason === "reconcile",
      dependencies.nowIso?.()
    )
  ) {
    const listing = await reconcileFromListing(
      dependencies,
      cursor,
      Math.max(maxPages * 4, 200)
    );
    reconciled = listing.complete;
    pages += listing.pages;
    changes += listing.changes;
  }
  return { mode: "incremental", cursor, pages, changes, reconciled, complete };
}

export type DriveSyncSource = {
  companyId: string;
  callerId: string;
  sourceId: string;
};

export function databaseDriveLedger(
  pool: Pool,
  principal: DatabasePrincipal,
  sourceId: string
): DriveLedger {
  return {
    items: (fileIds) => listDriveItems(pool, principal, sourceId, fileIds),
    all: () => listDriveLedger(pool, principal, sourceId),
    descendants: (changedIds) =>
      listDriveDescendants(pool, principal, sourceId, changedIds)
  };
}

/**
 * Synchronizes every enrolled Drive source this worker is a machine caller
 * for. Push notifications and portal requests arrive as `knowledge/drive.sync`
 * hints; the five-minute cron is the recovery path that needs no hint at all.
 * Runs are serialized per source, one sync per step, with a page budget that
 * hands a long backlog to a follow-up event instead of an unbounded step.
 */
export function createDriveSyncFunction(runtime: {
  pool: Pool;
  sources: ReadonlyArray<DriveSyncSource>;
  automationUserId: string;
  workerId: string;
  connectorAccessToken: (sourceId: string) => Promise<string | null>;
  createClient: (accessToken: string) => DriveApiClient;
  maxPages?: number;
}) {
  return knowledgeInngest.createFunction(
    {
      id: "knowledge-drive-sync",
      retries: 2,
      concurrency: [{ limit: 1, key: "event.data.sourceId" }]
    },
    [{ event: "knowledge/drive.sync" }, { cron: "*/5 * * * *" }],
    async ({ event, step }) => {
      const data =
        "data" in event && event.data && typeof event.data === "object"
          ? (event.data as Record<string, unknown>)
          : {};
      const requestedSource =
        typeof data.sourceId === "string" ? data.sourceId : undefined;
      const requestedCompany =
        typeof data.companyId === "string" ? data.companyId : undefined;
      const reason: DriveSyncReason =
        data.reason === "hint" ||
        data.reason === "requested" ||
        data.reason === "reconcile"
          ? data.reason
          : "scheduled";
      const sources = runtime.sources.filter(
        (source) =>
          (!requestedSource || source.sourceId === requestedSource) &&
          (!requestedCompany || source.companyId === requestedCompany)
      );
      const outcomes: Array<{ sourceId: string; complete: boolean }> = [];
      for (const source of sources) {
        const principal: DatabasePrincipal = {
          companyId: source.companyId,
          callerId: source.callerId,
          sourceId: source.sourceId
        };
        const outcome = await step.run(`sync-${source.sourceId}`, async () => {
          try {
            const enrollment = await getDriveEnrollment(
              runtime.pool,
              principal,
              source.sourceId
            );
            const accessToken = await runtime.connectorAccessToken(
              source.sourceId
            );
            if (!accessToken)
              throw new Error("Drive connector credential is unavailable");
            const result = await runDriveSync(
              {
                client: runtime.createClient(accessToken),
                enrollment,
                ledger: databaseDriveLedger(
                  runtime.pool,
                  principal,
                  source.sourceId
                ),
                persistPage: (page) =>
                  persistDriveChangePage(runtime.pool, principal, {
                    sourceId: source.sourceId,
                    automationUserId: runtime.automationUserId,
                    ...page
                  }),
                maxPages: runtime.maxPages
              },
              reason
            );
            await recordDriveSyncOutcome(runtime.pool, principal, {
              sourceId: source.sourceId,
              automationUserId: runtime.automationUserId,
              status: "succeeded",
              reconciled: result.reconciled
            });
            return { complete: result.complete, pages: result.pages };
          } catch (error) {
            await recordDriveSyncOutcome(runtime.pool, principal, {
              sourceId: source.sourceId,
              automationUserId: runtime.automationUserId,
              status: "failed",
              error: error instanceof Error ? error.message : "sync failed"
            }).catch(() => undefined);
            throw error;
          }
        });
        outcomes.push({
          sourceId: source.sourceId,
          complete: outcome.complete
        });
        if (!outcome.complete)
          await step.sendEvent(`continue-${source.sourceId}`, {
            name: "knowledge/drive.sync",
            data: {
              companyId: source.companyId,
              sourceId: source.sourceId,
              reason
            }
          });
      }
      return { synced: outcomes.length, outcomes };
    }
  );
}
