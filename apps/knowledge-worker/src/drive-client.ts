import { randomUUID } from "node:crypto";
import {
  DRIVE_SHORTCUT_MIME_TYPE,
  type DriveDocument,
  type DrivePermission
} from "@carbon/knowledge/sources/drive.server";

export type GooglePermission = {
  id?: string;
  type?: "user" | "group" | "domain" | "anyone";
  emailAddress?: string;
  domain?: string;
  role?: string;
  permissionDetails?: Array<{ inherited?: boolean; inheritedFrom?: string }>;
};
export type GoogleFile = {
  id: string;
  driveId?: string;
  name?: string;
  parents?: string[];
  trashed?: boolean;
  mimeType?: string;
  shortcutDetails?: { targetId?: string };
  version?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
};
export type GoogleChange = {
  changeType?: "file" | "drive";
  fileId?: string;
  driveId?: string;
  removed?: boolean;
  file?: GoogleFile;
  drive?: { id?: string };
};
export type GoogleChangePage = {
  nextPageToken?: string;
  newStartPageToken?: string;
  changes?: GoogleChange[];
};
export type GoogleFilePage = { nextPageToken?: string; files?: GoogleFile[] };

/**
 * The bounded Drive surface the connector uses. Everything the sync engine
 * needs is behind this type so tests run against an in-memory fake and
 * never a real Drive.
 */
export type DriveApiClient = {
  getStartPageToken(driveId: string | null): Promise<string>;
  listChanges(
    pageToken: string,
    driveId: string | null
  ): Promise<GoogleChangePage>;
  listFiles(input: {
    driveId: string | null;
    parentId?: string;
    pageToken?: string;
  }): Promise<GoogleFilePage>;
  /** Batched files.get: `null` marks a target the connector cannot read. */
  getFiles(fileIds: readonly string[]): Promise<Map<string, GoogleFile | null>>;
  /** Batched permissions.list: `null` marks an ACL that could not be read. */
  listPermissions(
    fileIds: readonly string[]
  ): Promise<Map<string, GooglePermission[] | null>>;
};

const api = "https://www.googleapis.com/drive/v3";
const batchApi = "https://www.googleapis.com/batch/drive/v3";
export const DRIVE_BATCH_LIMIT = 100;
const fileFields =
  "id,driveId,name,parents,trashed,mimeType,shortcutDetails(targetId),version,md5Checksum,sha256Checksum";
const permissionFields =
  "nextPageToken,permissions(id,type,emailAddress,domain,role,permissionDetails(inherited,inheritedFrom))";

export function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function statusError(operation: string, status: number): Error {
  return new Error(`Drive ${operation} failed (${status})`);
}

export function normalizeGooglePermissions(
  permissions: readonly GooglePermission[]
): DrivePermission[] {
  return permissions.flatMap((permission) => {
    const role: DrivePermission["role"] | undefined =
      permission.role === "owner" ||
      permission.role === "writer" ||
      permission.role === "reader" ||
      permission.role === "organizer" ||
      permission.role === "fileOrganizer" ||
      permission.role === "commenter"
        ? permission.role === "organizer" || permission.role === "fileOrganizer"
          ? "writer"
          : permission.role === "commenter"
            ? "reader"
            : permission.role
        : undefined;
    const principalId =
      permission.emailAddress?.toLowerCase() ??
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
}

export function googleFileToDocument(
  file: GoogleFile,
  driveId: string,
  permissions: readonly GooglePermission[] | null
): DriveDocument {
  return {
    id: file.id,
    driveId: file.driveId ?? driveId,
    parentIds: file.parents ?? [],
    blobHash: file.sha256Checksum ?? file.md5Checksum ?? "",
    trashed: Boolean(file.trashed),
    permissions: permissions ? normalizeGooglePermissions(permissions) : [],
    aclEvaluated: permissions !== null,
    name: file.name,
    mimeType: file.mimeType,
    revision: file.version,
    shortcutTargetId:
      file.mimeType === DRIVE_SHORTCUT_MIME_TYPE
        ? file.shortcutDetails?.targetId
        : undefined
  };
}

type BatchPart = { id: string; status: number; body: unknown };

function parseBatchResponse(contentType: string, text: string): BatchPart[] {
  const boundary = contentType.match(/boundary="?([^";]+)"?/)?.[1];
  if (!boundary) throw new Error("Drive batch response has no boundary");
  const parts: BatchPart[] = [];
  for (const raw of text.split(`--${boundary}`)) {
    const part = raw.trim();
    if (!part || part === "--") continue;
    const id = part.match(/^Content-ID:\s*<?response-([^>\r\n]+)>?/im)?.[1];
    const httpStart = part.search(/HTTP\/1\.[01] /);
    if (!id || httpStart < 0) continue;
    const http = part.slice(httpStart);
    const status = Number(http.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
    const bodyIndex = http.search(/\r?\n\r?\n/);
    const bodyText =
      bodyIndex >= 0
        ? http
            .slice(bodyIndex)
            .replace(/^\r?\n\r?\n/, "")
            .trim()
        : "";
    let body: unknown = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = null;
      }
    }
    parts.push({ id, status, body });
  }
  return parts;
}

export function createDriveApiClient(
  accessToken: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): DriveApiClient {
  if (!accessToken.trim()) throw new Error("Drive access token is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers = { Authorization: `Bearer ${accessToken}` };
  async function getJson<T>(operation: string, url: string): Promise<T> {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw statusError(operation, response.status);
    return (await response.json()) as T;
  }
  /**
   * One multipart batch request per hundred calls; a part that answers with
   * 401/403/404 is reported as unreadable (`null`) rather than failing the
   * whole page, and any other failure is thrown so nothing is guessed.
   */
  async function batch(
    operation: string,
    requests: ReadonlyArray<{ id: string; path: string }>
  ): Promise<Map<string, unknown | null>> {
    const results = new Map<string, unknown | null>();
    for (const group of chunk(requests, DRIVE_BATCH_LIMIT)) {
      const boundary = `knowledge-${randomUUID()}`;
      const body = `${group
        .map(
          (request) =>
            `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${request.id}>\r\n\r\nGET ${request.path} HTTP/1.1\r\n\r\n`
        )
        .join("")}--${boundary}--\r\n`;
      const response = await fetchImpl(batchApi, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": `multipart/mixed; boundary=${boundary}`
        },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw statusError(operation, response.status);
      const parts = parseBatchResponse(
        response.headers.get("content-type") ?? "",
        await response.text()
      );
      for (const request of group) {
        const part = parts.find((entry) => entry.id === request.id);
        if (!part) throw new Error(`Drive ${operation} batch part missing`);
        if (part.status === 401 || part.status === 403 || part.status === 404)
          results.set(request.id, null);
        else if (part.status >= 200 && part.status < 300)
          results.set(request.id, part.body);
        else throw statusError(operation, part.status);
      }
    }
    return results;
  }
  return {
    async getStartPageToken(driveId) {
      const params = new URLSearchParams({ supportsAllDrives: "true" });
      if (driveId) params.set("driveId", driveId);
      const result = await getJson<{ startPageToken?: string }>(
        "changes.getStartPageToken",
        `${api}/changes/startPageToken?${params}`
      );
      if (!result.startPageToken)
        throw new Error("Drive did not return a start page token");
      return result.startPageToken;
    },
    listChanges(pageToken, driveId) {
      const params = new URLSearchParams({
        pageToken,
        pageSize: "100",
        spaces: "drive",
        includeRemoved: "true",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        includeCorpusRemovals: "true",
        fields: `nextPageToken,newStartPageToken,changes(changeType,fileId,driveId,removed,file(${fileFields}),drive(id))`
      });
      if (driveId) params.set("driveId", driveId);
      return getJson<GoogleChangePage>(
        "changes.list",
        `${api}/changes?${params}`
      );
    },
    listFiles(input) {
      const params = new URLSearchParams({
        pageSize: "100",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        fields: `nextPageToken,files(${fileFields})`,
        q: input.parentId
          ? `'${input.parentId.replace(/'/g, "\\'")}' in parents and trashed = false`
          : "trashed = false"
      });
      if (input.driveId) {
        params.set("driveId", input.driveId);
        params.set("corpora", "drive");
      } else params.set("corpora", "user");
      if (input.pageToken) params.set("pageToken", input.pageToken);
      return getJson<GoogleFilePage>("files.list", `${api}/files?${params}`);
    },
    async getFiles(fileIds) {
      const unique = [...new Set(fileIds)];
      const results = await batch(
        "files.get",
        unique.map((id) => ({
          id: `f-${id}`,
          path: `/drive/v3/files/${encodeURIComponent(id)}?${new URLSearchParams({ supportsAllDrives: "true", fields: fileFields })}`
        }))
      );
      return new Map(
        unique.map((id) => {
          const value = results.get(`f-${id}`);
          return [
            id,
            value && typeof value === "object" && "id" in value
              ? (value as GoogleFile)
              : null
          ];
        })
      );
    },
    async listPermissions(fileIds) {
      const unique = [...new Set(fileIds)];
      const results = await batch(
        "permissions.list",
        unique.map((id) => ({
          id: `p-${id}`,
          path: `/drive/v3/files/${encodeURIComponent(id)}/permissions?${new URLSearchParams({ supportsAllDrives: "true", pageSize: "100", fields: permissionFields })}`
        }))
      );
      const output = new Map<string, GooglePermission[] | null>();
      for (const id of unique) {
        const value = results.get(`p-${id}`) as
          | { permissions?: GooglePermission[]; nextPageToken?: string }
          | null
          | undefined;
        if (!value) {
          output.set(id, null);
          continue;
        }
        const permissions = [...(value.permissions ?? [])];
        let token = value.nextPageToken;
        // A file with more than a hundred explicit permissions is rare enough
        // that its continuation is read directly; the ACL is still complete
        // or absent, never partial.
        while (token) {
          const page = await getJson<{
            permissions?: GooglePermission[];
            nextPageToken?: string;
          }>(
            "permissions.list",
            `${api}/files/${encodeURIComponent(id)}/permissions?${new URLSearchParams({ supportsAllDrives: "true", pageSize: "100", pageToken: token, fields: permissionFields })}`
          );
          permissions.push(...(page.permissions ?? []));
          token = page.nextPageToken;
        }
        output.set(id, permissions);
      }
      return output;
    }
  };
}

export async function checkDriveFileAccess(
  accessToken: string,
  fileId: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!accessToken.trim()) return false;
  const response = await fetchImpl(
    `${api}/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields: "id,trashed,capabilities(canDownload)", supportsAllDrives: "true" })}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000)
    }
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

/** Native Google documents are exported to PDF; everything else is fetched as stored. */
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
