import type {
  DriveChange,
  DriveDocument
} from "@carbon/knowledge/sources/drive.server";

type GooglePermission = {
  id?: string;
  type?: "user" | "group" | "domain" | "anyone";
  emailAddress?: string;
  domain?: string;
  role?: string;
  permissionDetails?: Array<{ inherited?: boolean; inheritedFrom?: string }>;
};
type GoogleFile = {
  id: string;
  driveId?: string;
  name?: string;
  parents?: string[];
  trashed?: boolean;
  mimeType?: string;
  shortcutDetails?: { targetId?: string };
  version?: string;
  permissions?: GooglePermission[];
};
type ChangePage = {
  nextPageToken?: string;
  newStartPageToken?: string;
  changes?: Array<{ fileId?: string; removed?: boolean; file?: GoogleFile }>;
};

const api = "https://www.googleapis.com/drive/v3";
export async function syncDriveChanges(input: {
  accessToken: string;
  pageToken: string;
  driveId: string;
  known: (id: string) => DriveDocument | undefined;
  onPage: (page: {
    expectedCursor: string;
    nextCursor: string;
    changes: DriveChange[];
    done: boolean;
  }) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  let token: string | undefined = input.pageToken;
  let cursor = input.pageToken;
  do {
    const response = await (input.fetchImpl ?? fetch)(
      `${api}/changes?${new URLSearchParams({ pageToken: token ?? "", spaces: "drive", includeItemsFromAllDrives: "true", supportsAllDrives: "true", driveId: input.driveId, fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,driveId,name,parents,trashed,mimeType,shortcutDetails,version,permissions(id,type,emailAddress,domain,role,permissionDetails(inherited,inheritedFrom))))" })}`,
      { headers: { Authorization: `Bearer ${input.accessToken}` } }
    );
    if (!response.ok)
      throw new Error(`Drive changes.list failed (${response.status})`);
    const page = (await response.json()) as ChangePage;
    const changes: DriveChange[] = (page.changes ?? []).flatMap((change) => {
      const file = change.file;
      const existing = change.fileId ? input.known(change.fileId) : undefined;
      if (!file && !existing) return [];
      const permissions = (file?.permissions ?? []).flatMap((permission) => {
        const role: "owner" | "writer" | "reader" | undefined =
          permission.role === "owner" ||
          permission.role === "writer" ||
          permission.role === "reader"
            ? permission.role
            : undefined;
        const principalId =
          permission.emailAddress ??
          permission.domain ??
          (permission.type === "anyone" ? "anyone" : undefined);
        if (!role || !principalId) return [];
        return [
          {
            permissionId: permission.id,
            principalId,
            principalKind: permission.type,
            role,
            inheritedFrom: permission.permissionDetails?.find(
              (detail) => detail.inherited
            )?.inheritedFrom
          }
        ];
      });
      const document: DriveDocument = file
        ? {
            id: file.id,
            driveId: file.driveId ?? input.driveId,
            parentIds: file.parents ?? [],
            blobHash: "",
            trashed: Boolean(file.trashed),
            permissions,
            name: file.name,
            mimeType: file.mimeType,
            revision: file.version,
            shortcutTargetId: file.shortcutDetails?.targetId
          }
        : { ...existing!, trashed: true };
      const permissionChanged =
        existing &&
        JSON.stringify(existing.permissions) !==
          JSON.stringify(document.permissions);
      const moved =
        existing &&
        JSON.stringify(existing.parentIds) !==
          JSON.stringify(document.parentIds);
      const kind =
        change.removed || document.trashed
          ? "delete"
          : permissionChanged
            ? "permission"
            : moved
              ? "move"
              : "upsert";
      return [
        { cursor: file?.version ?? change.fileId ?? cursor, kind, document }
      ];
    });
    const nextCursor = page.nextPageToken ?? page.newStartPageToken ?? cursor;
    await input.onPage({
      expectedCursor: cursor,
      nextCursor,
      changes,
      done: !page.nextPageToken
    });
    cursor = nextCursor;
    token = page.nextPageToken;
  } while (token);
  return cursor;
}

export async function checkDriveFileAccess(
  accessToken: string,
  fileId: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!accessToken.trim()) return false;
  const response = await fetchImpl(
    `${api}/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields: "id,trashed,capabilities(canDownload)", supportsAllDrives: "true" })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  )
    return false;
  if (!response.ok)
    throw new Error(`Drive files.get failed (${response.status})`);
  const file = (await response.json()) as {
    id?: string;
    trashed?: boolean;
    capabilities?: { canDownload?: boolean };
  };
  return (
    file.id === fileId &&
    !file.trashed &&
    file.capabilities?.canDownload === true
  );
}

async function readBoundedResponse(
  response: Response,
  maximum: number
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error(`Drive download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximum)
    throw new Error("Drive document exceeds the byte limit");
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maximum)
      throw new Error("Drive document exceeds the byte limit");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function downloadDriveDocument(
  accessToken: string,
  fileId: string,
  sourceMimeType: string,
  options: {
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maximum = options.maxBytes ?? 50_000_000;
  const native = sourceMimeType.startsWith("application/vnd.google-apps.");
  const mimeType = native ? "application/pdf" : sourceMimeType;
  const url = native
    ? `${api}/files/${encodeURIComponent(fileId)}/export?${new URLSearchParams({ mimeType })}`
    : `${api}/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true" })}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: options.signal
  });
  return { bytes: await readBoundedResponse(response, maximum), mimeType };
}

export async function exportGoogleDocument(
  accessToken: string,
  fileId: string,
  mimeType = "application/pdf"
): Promise<Uint8Array> {
  const response = await fetch(
    `${api}/files/${encodeURIComponent(fileId)}/export?${new URLSearchParams({ mimeType })}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) throw new Error(`Drive export failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
