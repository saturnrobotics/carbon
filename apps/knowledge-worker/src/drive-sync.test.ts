import type {
  DriveChange,
  DriveDocument
} from "@carbon/knowledge/sources/drive.server";
import { planDescendantInvalidation } from "@carbon/knowledge/sources/drive.server";
import { describe, expect, it, vi } from "vitest";
import type {
  DriveApiClient,
  GoogleChangePage,
  GoogleFile,
  GooglePermission
} from "./drive-client";
import {
  type DriveLedger,
  type DriveSyncDependencies,
  type DriveSyncPage,
  runDriveSync
} from "./drive-sync";

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const reader = (email: string): GooglePermission => ({
  id: `perm-${email}`,
  type: "user",
  emailAddress: email,
  role: "reader"
});

/**
 * An in-memory Drive. Every API call is recorded so a test can assert the
 * order of reads against the order of persisted pages. No network, no
 * credential, no real Drive.
 */
class FakeDrive implements DriveApiClient {
  readonly calls: string[] = [];
  files = new Map<string, GoogleFile>();
  permissions = new Map<string, GooglePermission[] | null>();
  changePages: GoogleChangePage[] = [];
  startPageToken = "start-1";
  private changeIndex = 0;

  add(file: GoogleFile, permissions: GooglePermission[] | null = []) {
    this.files.set(file.id, file);
    this.permissions.set(file.id, permissions);
    return this;
  }
  async getStartPageToken() {
    this.calls.push("startPageToken");
    return this.startPageToken;
  }
  async listChanges(pageToken: string) {
    this.calls.push(`changes:${pageToken}`);
    const page = this.changePages[this.changeIndex];
    if (!page) throw new Error(`no change page for ${pageToken}`);
    this.changeIndex += 1;
    return page;
  }
  async listFiles(input: { parentId?: string; pageToken?: string }) {
    this.calls.push(`files:${input.parentId ?? "*"}:${input.pageToken ?? ""}`);
    const matching = [...this.files.values()].filter(
      (file) =>
        !file.trashed &&
        (!input.parentId || file.parents?.includes(input.parentId))
    );
    const pageSize = 2;
    const offset = Number(input.pageToken ?? 0);
    const files = matching.slice(offset, offset + pageSize);
    return {
      files,
      nextPageToken:
        offset + pageSize < matching.length
          ? String(offset + pageSize)
          : undefined
    };
  }
  async getFiles(fileIds: readonly string[]) {
    this.calls.push(`get:${[...fileIds].join(",")}`);
    return new Map(fileIds.map((id) => [id, this.files.get(id) ?? null]));
  }
  async listPermissions(fileIds: readonly string[]) {
    this.calls.push(`permissions:${[...fileIds].join(",")}`);
    return new Map(
      fileIds.map((id) => [
        id,
        this.permissions.has(id) ? (this.permissions.get(id) ?? null) : null
      ])
    );
  }
}

function memoryLedger(initial: DriveDocument[] = []): DriveLedger & {
  rows: Map<string, DriveDocument>;
  apply(page: DriveSyncPage): void;
} {
  const rows = new Map(initial.map((item) => [item.id, item]));
  return {
    rows,
    apply(page) {
      for (const change of page.changes)
        rows.set(change.document.id, {
          ...change.document,
          trashed: change.kind === "delete" || change.document.trashed
        });
    },
    items: async (ids) =>
      ids.flatMap((id) => {
        const row = rows.get(id);
        return row ? [row] : [];
      }),
    all: async () => [...rows.values()].filter((row) => !row.trashed),
    descendants: async (changed) =>
      planDescendantInvalidation(changed, [...rows.values()])
  };
}

function harness(
  drive: FakeDrive,
  options: {
    enrollment?: Partial<DriveSyncDependencies["enrollment"]>;
    maxPages?: number;
    nowIso?: () => string;
    ledger?: ReturnType<typeof memoryLedger>;
    failPersistOn?: number;
  } = {}
) {
  const ledger = options.ledger ?? memoryLedger();
  const pages: DriveSyncPage[] = [];
  const dependencies: DriveSyncDependencies = {
    client: drive,
    enrollment: {
      driveId: "drive",
      rootFolderIds: [],
      cursor: "",
      reconciledAt: "2026-09-11T00:00:00Z",
      reconcileAfterHours: 24,
      ...options.enrollment
    },
    ledger,
    persistPage: async (page) => {
      drive.calls.push(`persist:${page.expectedCursor}>${page.nextCursor}`);
      if (options.failPersistOn === pages.length)
        throw new Error("database unavailable");
      pages.push(page);
      ledger.apply(page);
    },
    maxPages: options.maxPages,
    nowIso: options.nowIso ?? (() => "2026-09-11T01:00:00Z")
  };
  return { dependencies, pages, ledger };
}

const kinds = (page: DriveSyncPage) =>
  page.changes.map((change) => `${change.kind}:${change.document.id}`);

describe("runDriveSync", () => {
  it("takes the start token before the first listing, resolves ACLs and shortcuts in batches, then advances the cursor", async () => {
    const drive = new FakeDrive()
      .add({ id: "root", mimeType: FOLDER, parents: [] }, [
        reader("a@example.com")
      ])
      .add({ id: "team", mimeType: FOLDER, parents: ["root"] }, [
        reader("a@example.com")
      ])
      .add(
        {
          id: "spec",
          mimeType: "application/pdf",
          parents: ["team"],
          version: "3",
          md5Checksum: "m1"
        },
        [reader("a@example.com"), reader("b@example.com")]
      )
      .add(
        {
          id: "link",
          mimeType: SHORTCUT,
          parents: ["root"],
          version: "1",
          shortcutDetails: { targetId: "spec" }
        },
        [reader("a@example.com")]
      )
      .add(
        {
          id: "dangling",
          mimeType: SHORTCUT,
          parents: ["root"],
          version: "1",
          shortcutDetails: { targetId: "gone" }
        },
        [reader("a@example.com")]
      )
      .add(
        {
          id: "outside",
          mimeType: "application/pdf",
          parents: ["elsewhere"],
          version: "1"
        },
        null
      );
    const { dependencies, pages } = harness(drive, {
      enrollment: { rootFolderIds: ["root"] }
    });
    const result = await runDriveSync(dependencies);
    expect(result).toMatchObject({
      mode: "initial",
      cursor: "start-1",
      complete: true
    });
    expect(drive.calls[0]).toBe("startPageToken");
    // Folder scope walks root then team; nothing outside the enrolled folder is read.
    expect(drive.calls.filter((call) => call.startsWith("files:"))).toEqual([
      "files:root:",
      "files:root:2",
      "files:team:"
    ]);
    // One batch of target reads and one batch of permission reads for the page.
    expect(drive.calls.filter((call) => call.startsWith("get:"))).toEqual([
      "get:spec,gone"
    ]);
    expect(
      drive.calls.filter((call) => call.startsWith("permissions:"))
    ).toHaveLength(1);
    expect(pages.map((page) => [page.expectedCursor, page.nextCursor])).toEqual(
      [
        ["", ""],
        ["", "start-1"]
      ]
    );
    // A shortcut whose target the connector cannot read never appears.
    expect(kinds(pages[0]!).sort()).toEqual([
      "upsert:link",
      "upsert:spec",
      "upsert:team"
    ]);
    const link = pages[0]!.changes.find(
      (change) => change.document.id === "link"
    )!;
    expect(link.document).toMatchObject({
      shortcutTargetId: "spec",
      mimeType: "application/pdf",
      blobHash: "m1",
      aclEvaluated: true,
      permissions: [
        { principalId: "a@example.com", principalKind: "user", role: "reader" }
      ]
    });
  });

  it("persists each change page before requesting the next token and stops when persistence fails", async () => {
    const drive = new FakeDrive()
      .add(
        { id: "a", mimeType: "application/pdf", parents: [], version: "1" },
        [reader("a@example.com")]
      )
      .add(
        { id: "b", mimeType: "application/pdf", parents: [], version: "1" },
        [reader("a@example.com")]
      );
    drive.changePages = [
      {
        nextPageToken: "t2",
        changes: [
          { changeType: "file", fileId: "a", file: drive.files.get("a") }
        ]
      },
      {
        newStartPageToken: "t3",
        changes: [
          { changeType: "file", fileId: "b", file: drive.files.get("b") }
        ]
      }
    ];
    const { dependencies, pages } = harness(drive, {
      enrollment: { cursor: "t1" }
    });
    const result = await runDriveSync(dependencies);
    expect(result).toMatchObject({
      mode: "incremental",
      cursor: "t3",
      pages: 2,
      complete: true,
      reconciled: false
    });
    expect(
      drive.calls.filter(
        (call) => !call.startsWith("permissions:") && !call.startsWith("get:")
      )
    ).toEqual(["changes:t1", "persist:t1>t2", "changes:t2", "persist:t2>t3"]);
    expect(pages.map(kinds)).toEqual([["upsert:a"], ["upsert:b"]]);

    const failing = new FakeDrive().add({
      id: "a",
      mimeType: "application/pdf",
      parents: [],
      version: "1"
    });
    failing.changePages = [
      {
        nextPageToken: "t2",
        changes: [
          { changeType: "file", fileId: "a", file: failing.files.get("a") }
        ]
      },
      { newStartPageToken: "t3", changes: [] }
    ];
    const broken = harness(failing, {
      enrollment: { cursor: "t1" },
      failPersistOn: 0
    });
    await expect(runDriveSync(broken.dependencies)).rejects.toThrow(
      "database unavailable"
    );
    expect(failing.calls.filter((call) => call.startsWith("changes:"))).toEqual(
      ["changes:t1"]
    );
    expect(broken.pages).toEqual([]);
  });

  it("re-reads every descendant and dependent shortcut after a folder permission change, before the page itself", async () => {
    const existing: DriveDocument[] = [
      {
        id: "folder",
        driveId: "drive",
        parentIds: [],
        blobHash: "",
        trashed: false,
        mimeType: FOLDER,
        name: "folder",
        revision: "1",
        aclEvaluated: true,
        permissions: [
          {
            principalId: "a@example.com",
            principalKind: "user",
            role: "reader"
          }
        ]
      },
      {
        id: "child",
        driveId: "drive",
        parentIds: ["folder"],
        blobHash: "c",
        trashed: false,
        mimeType: "application/pdf",
        name: "child",
        revision: "1",
        aclEvaluated: true,
        permissions: [
          {
            principalId: "a@example.com",
            principalKind: "user",
            role: "reader"
          }
        ]
      },
      {
        id: "shortcut",
        driveId: "drive",
        parentIds: [],
        blobHash: "c",
        trashed: false,
        mimeType: "application/pdf",
        name: "shortcut",
        revision: "1:1",
        shortcutTargetId: "child",
        aclEvaluated: true,
        permissions: [
          {
            principalId: "a@example.com",
            principalKind: "user",
            role: "reader"
          }
        ]
      },
      {
        id: "sibling",
        driveId: "drive",
        parentIds: [],
        blobHash: "s",
        trashed: false,
        mimeType: "application/pdf",
        name: "sibling",
        revision: "1",
        aclEvaluated: true,
        permissions: [
          {
            principalId: "a@example.com",
            principalKind: "user",
            role: "reader"
          }
        ]
      }
    ];
    const drive = new FakeDrive()
      .add({ id: "folder", mimeType: FOLDER, parents: [], version: "2" }, [])
      .add(
        {
          id: "child",
          mimeType: "application/pdf",
          parents: ["folder"],
          version: "1",
          md5Checksum: "c"
        },
        []
      )
      .add(
        {
          id: "shortcut",
          mimeType: SHORTCUT,
          parents: [],
          version: "1",
          shortcutDetails: { targetId: "child" }
        },
        [reader("a@example.com")]
      )
      .add(
        {
          id: "sibling",
          mimeType: "application/pdf",
          parents: [],
          version: "1",
          md5Checksum: "s"
        },
        [reader("a@example.com")]
      );
    drive.changePages = [
      {
        newStartPageToken: "t2",
        changes: [
          {
            changeType: "file",
            fileId: "folder",
            file: drive.files.get("folder")
          }
        ]
      }
    ];
    const ledger = memoryLedger(existing);
    const { dependencies, pages } = harness(drive, {
      enrollment: { cursor: "t1" },
      ledger
    });
    await runDriveSync(dependencies);
    expect(
      pages.map((page) => [page.expectedCursor, page.nextCursor, kinds(page)])
    ).toEqual([
      ["t1", "t1", ["permission:child", "permission:shortcut"]],
      ["t1", "t2", ["upsert:folder"]]
    ]);
    const child = pages[0]!.changes[0]!.document;
    expect(child.permissions).toEqual([]);
    const shortcut = pages[0]!.changes[1]!.document;
    // The shortcut keeps its own reader but the target lost them all: nothing survives the intersection.
    expect(shortcut.permissions).toEqual([]);
    expect(drive.calls.filter((call) => call.startsWith("get:"))).toContain(
      "get:child,shortcut"
    );
  });

  it("tombstones removed files, inaccessible shortcuts and every item of a removed drive", async () => {
    const existing: DriveDocument[] = [
      {
        id: "a",
        driveId: "drive",
        parentIds: [],
        blobHash: "a",
        trashed: false,
        mimeType: "application/pdf",
        revision: "1",
        permissions: [],
        aclEvaluated: true
      },
      {
        id: "b",
        driveId: "drive",
        parentIds: [],
        blobHash: "b",
        trashed: false,
        mimeType: "application/pdf",
        revision: "1",
        permissions: [],
        aclEvaluated: true
      }
    ];
    const drive = new FakeDrive().add(
      {
        id: "link",
        mimeType: SHORTCUT,
        parents: [],
        version: "1",
        shortcutDetails: { targetId: "missing" }
      },
      [reader("a@example.com")]
    );
    drive.changePages = [
      {
        nextPageToken: "t2",
        changes: [
          { changeType: "file", fileId: "a", removed: true },
          { changeType: "file", fileId: "link", file: drive.files.get("link") }
        ]
      },
      {
        newStartPageToken: "t3",
        changes: [
          {
            changeType: "drive",
            driveId: "drive",
            removed: true,
            drive: { id: "drive" }
          }
        ]
      }
    ];
    const { dependencies, pages } = harness(drive, {
      enrollment: { cursor: "t1" },
      ledger: memoryLedger(existing)
    });
    await runDriveSync(dependencies);
    expect(pages.map(kinds)).toEqual([
      ["delete:a", "delete:link"],
      ["delete:b"]
    ]);
  });

  it("hands a long backlog to a follow-up run and reconciles from a full listing only when due", async () => {
    const drive = new FakeDrive().add(
      {
        id: "a",
        mimeType: "application/pdf",
        parents: [],
        version: "1",
        md5Checksum: "a"
      },
      [reader("a@example.com")]
    );
    drive.changePages = [
      { nextPageToken: "t2", changes: [] },
      { nextPageToken: "t3", changes: [] },
      { newStartPageToken: "t4", changes: [] }
    ];
    const bounded = harness(drive, {
      enrollment: { cursor: "t1" },
      maxPages: 2
    });
    await expect(runDriveSync(bounded.dependencies)).resolves.toMatchObject({
      complete: false,
      cursor: "t3",
      pages: 2
    });

    // A later run past the reconciliation interval lists the drive and persists only the difference.
    const stale: DriveDocument[] = [
      {
        id: "a",
        driveId: "drive",
        parentIds: [],
        blobHash: "a",
        trashed: false,
        mimeType: "application/pdf",
        name: "a",
        revision: "1",
        aclEvaluated: true,
        permissions: [
          {
            principalId: "a@example.com",
            principalKind: "user",
            role: "reader",
            permissionId: "perm-a@example.com"
          }
        ]
      },
      {
        id: "vanished",
        driveId: "drive",
        parentIds: [],
        blobHash: "v",
        trashed: false,
        mimeType: "application/pdf",
        name: "vanished",
        revision: "1",
        permissions: [],
        aclEvaluated: true
      }
    ];
    const recovering = new FakeDrive().add(
      {
        id: "a",
        name: "a",
        mimeType: "application/pdf",
        parents: [],
        version: "1",
        md5Checksum: "a"
      },
      [reader("a@example.com")]
    );
    recovering.changePages = [{ newStartPageToken: "t4", changes: [] }];
    const due = harness(recovering, {
      enrollment: { cursor: "t3", reconciledAt: "2026-09-01T00:00:00Z" },
      ledger: memoryLedger(stale)
    });
    const result = await runDriveSync(due.dependencies);
    expect(result).toMatchObject({
      complete: true,
      reconciled: true,
      cursor: "t4"
    });
    expect(
      due.pages.map((page) => [
        page.expectedCursor,
        page.nextCursor,
        kinds(page)
      ])
    ).toEqual([
      ["t3", "t4", []],
      ["t4", "t4", ["delete:vanished"]]
    ]);
    // Not due: no listing at all.
    const fresh = new FakeDrive();
    fresh.changePages = [{ newStartPageToken: "t5", changes: [] }];
    const notDue = harness(fresh, { enrollment: { cursor: "t4" } });
    await expect(runDriveSync(notDue.dependencies)).resolves.toMatchObject({
      reconciled: false
    });
    expect(fresh.calls.filter((call) => call.startsWith("files:"))).toEqual([]);
  });

  it("marks an item whose ACL cannot be read as unevaluated instead of guessing", async () => {
    const drive = new FakeDrive().add(
      { id: "opaque", mimeType: "application/pdf", parents: [], version: "1" },
      null
    );
    drive.changePages = [
      {
        newStartPageToken: "t2",
        changes: [
          {
            changeType: "file",
            fileId: "opaque",
            file: drive.files.get("opaque")
          }
        ]
      }
    ];
    const { dependencies, pages } = harness(drive, {
      enrollment: { cursor: "t1" }
    });
    await runDriveSync(dependencies);
    const change: DriveChange | undefined = pages[0]?.changes[0];
    expect(change?.document).toMatchObject({
      aclEvaluated: false,
      permissions: []
    });
  });

  it("does not persist anything when the change read itself fails", async () => {
    const drive = new FakeDrive();
    drive.listChanges = vi
      .fn()
      .mockRejectedValue(new Error("Drive changes.list failed (503)"));
    const { dependencies, pages } = harness(drive, {
      enrollment: { cursor: "t1" }
    });
    await expect(runDriveSync(dependencies)).rejects.toThrow("503");
    expect(pages).toEqual([]);
  });
});
