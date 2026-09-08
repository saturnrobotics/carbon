import { describe, expect, it } from "vitest";
import { applyDriveChanges, canDeliverDriveDocument } from "./drive.server";

const restricted = {
  id: "pdf",
  driveId: "a",
  parentIds: ["folder"],
  blobHash: "a".repeat(64),
  trashed: false,
  permissions: [{ principalId: "engineering", role: "reader" as const }]
};

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
