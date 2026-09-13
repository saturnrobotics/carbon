import {
  canDeliverDriveDocument,
  type DriveDocument,
  type DrivePermission
} from "@carbon/knowledge/sources/drive.server";
import { checkDriveFileAccess } from "./drive-client";

export async function authorizeBeforeModel(
  document: DriveDocument,
  userId: string,
  inherited: readonly DrivePermission[],
  liveCheck: (documentId: string, principalId: string) => Promise<boolean>
): Promise<void> {
  if (!(await canDeliverDriveDocument(document, userId, inherited, liveCheck)))
    throw new Error("Drive document is no longer authorized for this user");
}

/**
 * The live, user-delegated check that runs before restricted Drive text is
 * delivered, cached or disclosed to a provider. It is performed with the
 * reader's own delegated token, never the connector's; a shortcut requires
 * the reader to open both the shortcut and its target. No token means no
 * delivery: the local ACL sync is never a substitute for this check.
 */
export async function liveDriveDocumentAccess(input: {
  accessToken: string | null;
  fileId: string;
  shortcutTargetId?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!input.accessToken) return false;
  const ids = [
    input.fileId,
    ...(input.shortcutTargetId ? [input.shortcutTargetId] : [])
  ];
  const results = await Promise.all(
    ids.map((id) =>
      checkDriveFileAccess(input.accessToken!, id, input.fetchImpl)
    )
  );
  return results.every(Boolean);
}
