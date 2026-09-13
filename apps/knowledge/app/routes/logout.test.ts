import { describe, expect, it } from "vitest";
import { action, IAP_CLEAR_LOGIN_COOKIE_PATH, loader } from "./logout";

describe("portal sign-out", () => {
  it("clears private browser state and the IAP login cookie without caching", () => {
    for (const response of [loader(), action()]) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        IAP_CLEAR_LOGIN_COOKIE_PATH
      );
      const clear = response.headers.get("clear-site-data") ?? "";
      expect(clear).toContain('"storage"');
      expect(clear).toContain('"cache"');
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });
  it("stays on this origin so the IAP handler, not an open redirect, is reached", () => {
    expect(IAP_CLEAR_LOGIN_COOKIE_PATH.startsWith("/")).toBe(true);
    expect(IAP_CLEAR_LOGIN_COOKIE_PATH.startsWith("//")).toBe(false);
  });
});
