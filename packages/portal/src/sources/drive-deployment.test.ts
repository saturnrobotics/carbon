import { describe, expect, it } from "vitest";
import {
  DRIVE_SURFACE_ENABLED_VARIABLE,
  isDriveSurfaceEnabled
} from "./drive-deployment";

describe("Drive portal surface release gate", () => {
  it("is off with nothing configured, which is every release image's build", () => {
    expect(isDriveSurfaceEnabled({})).toBe(false);
    expect(isDriveSurfaceEnabled({ PORTAL_RELEASE_PROFILE: "manual-v1" })).toBe(
      false
    );
  });

  it("requires the exact string true, not a truthy-looking value", () => {
    for (const value of ["1", "yes", "TRUE", "True", "", " ", "false", "0"])
      expect(
        isDriveSurfaceEnabled({ [DRIVE_SURFACE_ENABLED_VARIABLE]: value })
      ).toBe(false);
  });

  it("is on only for an explicit opt-in", () => {
    expect(
      isDriveSurfaceEnabled({ [DRIVE_SURFACE_ENABLED_VARIABLE]: "true" })
    ).toBe(true);
    expect(
      isDriveSurfaceEnabled({ [DRIVE_SURFACE_ENABLED_VARIABLE]: " true " })
    ).toBe(true);
  });
});
