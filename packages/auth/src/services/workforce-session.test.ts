import { describe, expect, it, vi } from "vitest";

vi.mock("@carbon/kv", () => ({ redis: { del: vi.fn() } }));
vi.mock("../config/env", () => ({
  CarbonEdition: "Test",
  CONTROLLED_ENVIRONMENT: false,
  DOMAIN: "example.com",
  ERP_URL: "https://erp.example.com",
  MES_URL: "https://mes.example.com",
  REFRESH_ACCESS_TOKEN_THRESHOLD: 60,
  SESSION_ABSOLUTE_MAX_MS: 1000,
  SESSION_IDLE_LOCK_MS: 1000,
  SESSION_KEY: "auth",
  SESSION_MAX_AGE: 3600,
  SESSION_SECRET: "test-secret"
}));
vi.mock("./auth.server", () => ({}));
vi.mock("./company.server", () => ({ setCompanyId: vi.fn() }));
vi.mock("./mfa.server", () => ({}));
vi.mock("./users", () => ({ getPermissionCacheKey: vi.fn() }));

import { getAuthSessionCookieOptions } from "./session.server";

describe("workforce session cookies", () => {
  it.each([
    ["https://erp.example.com", "carbon-erp"],
    ["https://mes.example.com", "carbon-mes"]
  ])("uses a secure host-only cookie for %s", (url, name) => {
    expect(
      getAuthSessionCookieOptions(new Request(url), {
        erpUrl: "https://erp.example.com",
        mesUrl: "https://mes.example.com",
        isDevelopment: false
      })
    ).toEqual({
      name,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: true,
      secrets: expect.any(Array)
    });
  });

  it("allows insecure cookies only for an explicit local development request", () => {
    expect(
      getAuthSessionCookieOptions(new Request("http://localhost:3000"), {
        erpUrl: "http://localhost:3000",
        mesUrl: "http://localhost:3001",
        isDevelopment: true
      }).secure
    ).toBe(false);
    expect(
      getAuthSessionCookieOptions(new Request("http://erp.example.com"), {
        erpUrl: "http://erp.example.com",
        mesUrl: "http://mes.example.com",
        isDevelopment: true
      }).secure
    ).toBe(true);
  });

  it("never configures a parent domain", () => {
    expect(
      getAuthSessionCookieOptions(new Request("https://erp.example.com"), {
        erpUrl: "https://erp.example.com",
        mesUrl: "https://mes.example.com",
        isDevelopment: false
      })
    ).not.toHaveProperty("domain");
  });
});
