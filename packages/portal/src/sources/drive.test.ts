import { describe, expect, it } from "vitest";
import {
  applyDriveChanges,
  canDeliverDriveDocument,
  type DriveDocument,
  driveReconciliationDue,
  intersectPermissions,
  planDescendantInvalidation,
  reconcileDriveListing,
  resolveDriveScope
} from "./drive.server";

const restricted = {
  id: "pdf",
  driveId: "a",
  parentIds: ["folder"],
  blobHash: "a".repeat(64),
  trashed: false,
  permissions: [{ principalId: "engineering", role: "reader" as const }]
};

function item(
  id: string,
  parentIds: string[],
  extra: Partial<DriveDocument> = {}
): DriveDocument {
  return {
    id,
    driveId: "drive",
    parentIds,
    blobHash: `hash-${id}`,
    trashed: false,
    permissions: [
      {
        principalId: "alice@example.com",
        principalKind: "user",
        role: "reader"
      }
    ],
    name: id,
    mimeType: "application/pdf",
    revision: "1",
    aclEvaluated: true,
    ...extra
  };
}

describe("Drive connector authorization", () => {
  it("requires a successful live source check before a document reaches a user", async () => {
    await expect(
      canDeliverDriveDocument(restricted, "person", [
        { principalId: "person", role: "reader", inheritedFrom: "folder" }
      ])
    ).resolves.toBe(false);
    await expect(
      canDeliverDriveDocument(
        restricted,
        "person",
        [{ principalId: "person", role: "reader", inheritedFrom: "folder" }],
        async () => false
      )
    ).resolves.toBe(false);
    await expect(
      canDeliverDriveDocument(
        restricted,
        "person",
        [{ principalId: "person", role: "reader", inheritedFrom: "folder" }],
        async () => true
      )
    ).resolves.toBe(true);
  });
  it("does not treat a domain marker as every employee", async () => {
    await expect(
      canDeliverDriveDocument(
        {
          ...restricted,
          permissions: [{ principalId: "domain", role: "reader" }]
        },
        "person",
        [],
        async () => true
      )
    ).resolves.toBe(false);
  });
  it("keeps a duplicate blob in another Drive independently hidden and emits parent permission invalidation", async () => {
    await expect(
      canDeliverDriveDocument(
        { ...restricted, driveId: "b", permissions: [] },
        "person",
        [],
        async () => true
      )
    ).resolves.toBe(false);
    expect(
      applyDriveChanges("one", [
        { cursor: "two", kind: "permission", document: restricted }
      ]).aclChanged
    ).toEqual(["pdf"]);
  });
});

describe("Drive scope and descendants", () => {
  const folder = item("folder", ["root"], {
    mimeType: "application/vnd.google-apps.folder"
  });
  const nested = item("nested", ["folder"], {
    mimeType: "application/vnd.google-apps.folder"
  });
  const deep = item("deep", ["nested"]);
  const outside = item("outside", ["elsewhere"]);
  const shortcut = item("shortcut", ["root"], {
    mimeType: "application/vnd.google-apps.shortcut",
    shortcutTargetId: "deep"
  });
  const ledger = new Map(
    [folder, nested, deep, outside, shortcut].map((entry) => [entry.id, entry])
  );

  it("resolves scope through the ancestor chain and treats the whole drive as in scope without root folders", () => {
    expect(resolveDriveScope(deep, ["root"], ledger)).toBe(true);
    expect(resolveDriveScope(outside, ["root"], ledger)).toBe(false);
    expect(resolveDriveScope(outside, [], ledger)).toBe(true);
    expect(resolveDriveScope({ ...deep, trashed: true }, [], ledger)).toBe(
      false
    );
    const cyclic = new Map([
      ["a", { parentIds: ["b"], trashed: false }],
      ["b", { parentIds: ["a"], trashed: false }]
    ]);
    expect(
      resolveDriveScope(
        { id: "x", parentIds: ["a"], trashed: false },
        ["r"],
        cyclic
      )
    ).toBe(false);
  });

  it("plans every descendant and every shortcut to one after a folder change", () => {
    expect(
      planDescendantInvalidation(["folder"], [...ledger.values()])
    ).toEqual(["deep", "nested", "shortcut"]);
    expect(
      planDescendantInvalidation(["outside"], [...ledger.values()])
    ).toEqual([]);
  });

  it("intersects a shortcut's principals with its target's roles", () => {
    expect(
      intersectPermissions(
        [
          { principalId: "alice@example.com", role: "writer" },
          { principalId: "bob@example.com", role: "reader" }
        ],
        [
          { principalId: "alice@example.com", role: "reader" },
          { principalId: "carol@example.com", role: "reader" }
        ]
      )
    ).toEqual([{ principalId: "alice@example.com", role: "reader" }]);
  });
});

describe("Drive reconciliation", () => {
  it("diffs a listing against the ledger so an unchanged drive persists nothing", () => {
    const ledger = [item("a", ["root"]), item("b", ["root"])];
    expect(reconcileDriveListing("cursor", ledger, ledger)).toEqual([]);
    const changes = reconcileDriveListing(
      "cursor",
      [
        item("a", ["root"], { revision: "2" }),
        item("c", ["root"]),
        item("d", ["root"], { trashed: true })
      ],
      [...ledger, item("d", ["root"])]
    );
    expect(changes.map((change) => [change.kind, change.document.id])).toEqual([
      ["upsert", "a"],
      ["upsert", "c"],
      ["delete", "d"],
      ["delete", "b"]
    ]);
  });

  it("classifies ACL-only and placement-only differences", () => {
    const ledger = [item("a", ["root"]), item("b", ["root"])];
    const changes = reconcileDriveListing(
      "cursor",
      [
        item("a", ["root"], {
          permissions: [
            {
              principalId: "carol@example.com",
              principalKind: "user",
              role: "reader"
            }
          ]
        }),
        item("b", ["other"])
      ],
      ledger
    );
    expect(changes.map((change) => [change.kind, change.document.id])).toEqual([
      ["permission", "a"],
      ["move", "b"]
    ]);
  });

  it("is due when never reconciled, when forced, or once the interval has elapsed", () => {
    expect(
      driveReconciliationDue(
        { reconciledAt: null, reconcileAfterHours: 24 },
        false
      )
    ).toBe(true);
    expect(
      driveReconciliationDue(
        { reconciledAt: "2026-09-11T00:00:00Z", reconcileAfterHours: 24 },
        false,
        "2026-09-11T23:59:59Z"
      )
    ).toBe(false);
    expect(
      driveReconciliationDue(
        { reconciledAt: "2026-09-11T00:00:00Z", reconcileAfterHours: 24 },
        false,
        "2026-09-12T00:00:00Z"
      )
    ).toBe(true);
    expect(
      driveReconciliationDue(
        { reconciledAt: "2026-09-11T00:00:00Z", reconcileAfterHours: 24 },
        true,
        "2026-09-11T00:00:01Z"
      )
    ).toBe(true);
  });
});
