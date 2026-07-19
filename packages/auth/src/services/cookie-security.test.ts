import { describe, expect, it, vi } from "vitest";

vi.mock("@carbon/kv", () => ({
  redis: {
    del: vi.fn(),
    get: vi.fn(),
    set: vi.fn()
  }
}));

vi.mock("../config/env", () => ({
  CarbonEdition: "Community",
  DOMAIN: "hq.saturnrobotics.co",
  NODE_ENV: "production",
  REFRESH_ACCESS_TOKEN_THRESHOLD: 60,
  SESSION_KEY: "auth",
  SESSION_MAX_AGE: 60 * 60 * 24 * 7,
  SESSION_SECRET: "test-session-secret"
}));

vi.mock("../lib/supabase/client.server", () => ({
  getCarbonServiceRole: vi.fn(() => ({}))
}));

vi.mock("./auth.server", () => ({
  refreshAccessToken: vi.fn(),
  verifyAuthSession: vi.fn()
}));

vi.mock("./users", () => ({
  getPermissionCacheKey: (userId: string) => `permissions:${userId}`
}));

import { setCompanyId } from "./company.server";
import { setAuthSession } from "./session.server";

describe("deployed cookie isolation", () => {
  it("sets a secure host-only auth session cookie", async () => {
    const cookie = await setAuthSession(
      new Request("https://hq.saturnrobotics.co"),
      {
        authSession: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          userId: "user-1",
          companyId: "company-1",
          companyGroupId: "group-1",
          email: "user@saturnrobotics.co",
          expiresIn: 3600,
          expiresAt: Date.now() + 3600_000
        }
      }
    );

    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
  });

  it("sets a secure host-only company cookie", () => {
    const cookie = setCompanyId("company-1");

    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
  });
});
