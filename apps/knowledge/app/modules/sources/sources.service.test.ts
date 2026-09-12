import { describe, expect, it, vi } from "vitest";
import { requestDriveSourceSync } from "./sources.service";

describe("Drive source service", () => {
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
