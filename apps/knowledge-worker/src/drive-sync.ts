import {
  applyDriveChanges,
  type DriveChange
} from "@carbon/knowledge/sources/drive.server";

export type DriveChangePage = { nextCursor?: string; changes: DriveChange[] };
export async function syncDrive(
  cursor: string | undefined,
  readPage: (cursor: string | undefined) => Promise<DriveChangePage>
) {
  const page = await readPage(cursor);
  const result = applyDriveChanges(cursor, page.changes);
  return { ...result, cursor: page.nextCursor ?? result.cursor };
}

export async function syncDrivePages(
  initialCursor: string,
  readPage: (
    cursor: string
  ) => Promise<{ nextCursor: string; changes: DriveChange[]; done: boolean }>,
  persistPage: (page: {
    expectedCursor: string;
    nextCursor: string;
    changes: DriveChange[];
  }) => Promise<void>
): Promise<string> {
  let cursor = initialCursor;
  for (;;) {
    const page = await readPage(cursor);
    await persistPage({
      expectedCursor: cursor,
      nextCursor: page.nextCursor,
      changes: prioritizeChanges(page.changes)
    });
    cursor = page.nextCursor;
    if (page.done) return cursor;
  }
}

function prioritizeChanges(changes: readonly DriveChange[]): DriveChange[] {
  return [...changes].sort((left, right) => priority(left) - priority(right));
}

function priority(change: DriveChange): number {
  if (change.kind === "delete" || change.document.trashed) return 0;
  if (change.kind === "permission" || change.kind === "move") return 1;
  return 2;
}
