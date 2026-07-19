import { describe, expect, it } from "vitest";
import { shouldUseSecureCookie } from "./cookie";

describe("shouldUseSecureCookie", () => {
  it("uses secure cookies for production without relying on a cookie domain", () => {
    expect(shouldUseSecureCookie(undefined, "production")).toBe(true);
  });

  it("uses secure cookies for HTTPS-style development domains", () => {
    expect(shouldUseSecureCookie("feature.dev", "development")).toBe(true);
  });

  it("allows insecure cookies for localhost development", () => {
    expect(shouldUseSecureCookie("localhost", "development")).toBe(false);
  });
});
