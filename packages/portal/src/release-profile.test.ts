import { expect, it } from "vitest";
import { readManualSourceConfiguration } from "./release-profile";

it("requires a bounded explicit source and rejects deferred release profiles", () => {
  expect(
    readManualSourceConfiguration({
      PORTAL_MANUAL_SOURCE_JSON:
        '{"sourceId":"manuals","displayName":"Manual library"}'
    })
  ).toEqual({ sourceId: "manuals", displayName: "Manual library" });
  expect(() => readManualSourceConfiguration({})).toThrow();
  expect(() =>
    readManualSourceConfiguration({
      PORTAL_RELEASE_PROFILE: "platform",
      PORTAL_MANUAL_SOURCE_JSON:
        '{"sourceId":"manuals","displayName":"Manual library"}'
    })
  ).toThrow();
  expect(() =>
    readManualSourceConfiguration({
      PORTAL_MANUAL_SOURCE_JSON:
        '{"sourceId":"manuals","displayName":"Manual library","allowCommands":true}'
    })
  ).toThrow();
});
