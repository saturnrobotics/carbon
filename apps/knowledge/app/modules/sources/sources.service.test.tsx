import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  type DriveSource,
  describeProviderEligibility,
  driveSourceListSchema,
  requestDriveSourceSync
} from "./sources.service";
import { DriveSourceList } from "./ui/DriveSourceList";

const source: DriveSource = {
  sourceId: "ksrc_drive",
  displayName: "Engineering drive",
  ownerId: "user_owner",
  classification: "internal",
  corpora: "drive",
  driveId: "0ADriveSynthetic",
  rootFolderIds: ["folder-a", "folder-b"],
  oauthScope: "https://www.googleapis.com/auth/drive.readonly",
  userAccessScope: "https://www.googleapis.com/auth/drive.metadata.readonly",
  domainWideDelegation: false,
  providerPolicy: {
    allowedProviders: ["vertex"],
    allowedClassifications: ["internal"]
  },
  reconcileAfterHours: 24,
  reconciledAt: "2026-09-11T00:00:00Z",
  lastSyncAt: "2026-09-11T01:00:00Z",
  lastSyncStatus: "succeeded",
  documentCount: 12
};

describe("Drive source settings", () => {
  it("describes provider eligibility from the recorded policy and admits nothing by default", () => {
    expect(describeProviderEligibility({})).toBe(
      "No external provider is admitted"
    );
    expect(describeProviderEligibility(source.providerPolicy)).toBe(
      "vertex for internal"
    );
  });

  it("rejects a worker answer that carries fields the page does not expect", () => {
    expect(
      driveSourceListSchema.parse({ sources: [source] }).sources
    ).toHaveLength(1);
    expect(() =>
      driveSourceListSchema.parse({
        sources: [{ ...source, credentialSecretRef: "projects/x/secrets/y" }]
      })
    ).toThrow();
  });

  it("renders scope, owner, admitted corpora, eligibility and sync state, never a credential", () => {
    const markup = renderToStaticMarkup(
      <DriveSourceList sources={[source]} requested={null} />
    );
    for (const text of [
      "Engineering drive",
      "Shared Drive 0ADriveSynthetic: 2 enrolled folders",
      "Read-only (no domain-wide delegation)",
      "drive.metadata.readonly",
      "user_owner",
      "vertex for internal",
      "12",
      "Last sync succeeded at 2026-09-11T01:00:00Z",
      "Reconcile now"
    ])
      expect(markup).toContain(text);
    expect(markup).not.toContain("secrets/");
    expect(
      renderToStaticMarkup(<DriveSourceList sources={[]} requested={null} />)
    ).toContain("No Google Drive sources are enrolled");
  });

  it("never forwards a malformed source id to the worker", async () => {
    const fetchImpl = vi.fn();
    await expect(
      requestDriveSourceSync(
        new Request("https://portal.example.com/settings/sources", {
          method: "POST"
        }),
        "../escape",
        {},
        fetchImpl
      )
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
