import {
  canDeliverDriveDocument,
  type DriveDocument,
  type DrivePermission
} from "@carbon/knowledge/sources/drive.server";

export async function authorizeBeforeModel(
  document: DriveDocument,
  userId: string,
  inherited: readonly DrivePermission[],
  liveCheck: (documentId: string, principalId: string) => Promise<boolean>
): Promise<void> {
  if (!(await canDeliverDriveDocument(document, userId, inherited, liveCheck)))
    throw new Error("Drive document is no longer authorized for this user");
}
