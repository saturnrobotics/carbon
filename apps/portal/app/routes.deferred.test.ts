import { DRIVE_SURFACE_ENABLED_VARIABLE } from "@carbon/portal/sources/drive-deployment";
import { describe, expect, it } from "vitest";
import { deferredDriveRoutes } from "./routes.deferred";

describe("deferred web route manifest", () => {
  it("contributes no route to a release build, which names neither value", () => {
    expect(deferredDriveRoutes({})).toEqual([]);
    expect(
      deferredDriveRoutes({ PORTAL_RELEASE_PROFILE: "manual-v1" })
    ).toEqual([]);
    expect(
      deferredDriveRoutes({ [DRIVE_SURFACE_ENABLED_VARIABLE]: "1" })
    ).toEqual([]);
  });

  it("contributes the Drive settings route once a build opts in explicitly", () => {
    expect(
      deferredDriveRoutes({ [DRIVE_SURFACE_ENABLED_VARIABLE]: "true" })
    ).toEqual([
      expect.objectContaining({
        path: "settings/sources",
        file: "routes/settings.sources.tsx"
      })
    ]);
  });
});
