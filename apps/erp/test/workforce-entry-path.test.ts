import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real `@carbon/auth/session.server` is used below so the cookies on the
// callback response are the ones production issues. Its host resolution reads
// ERP_URL / MES_URL / DOMAIN from `@carbon/env` at import time, so they must be
// in place before any import runs.
vi.hoisted(() => {
  process.env.ERP_URL = "https://erp.example.com";
  process.env.MES_URL = "https://mes.example.com";
  process.env.DOMAIN = "example.com";
});

const harness = vi.hoisted(() => ({
  providers: new Set<string>(),
  signInWithOAuth: vi.fn(),
  mounts: [] as Array<() => unknown>,
  loaderData: {} as Record<string, unknown>,
  searchParams: new URLSearchParams(),
  hasTotp: vi.fn(),
  refresh: vi.fn(),
  user: vi.fn(),
  employeeCompanies: vi.fn(),
  companies: vi.fn(),
  lockoutReset: vi.fn()
}));

vi.mock("@carbon/auth", () => ({
  assertIsPost: (request: Request) => {
    if (request.method !== "POST") throw new Error("Expected POST");
  },
  CarbonEdition: "Enterprise",
  CONTROLLED_ENVIRONMENT: false,
  CARBON_API_URL: "https://api.example.com",
  SUPABASE_URL: "https://database.example.com",
  SOURCE_CODE_URL: "",
  RATE_LIMIT: 5,
  getAppUrl: () => "https://erp.example.com",
  getMESUrl: () => "https://mes.example.com",
  callbackValidator: {},
  magicLinkValidator: {},
  carbonClient: {
    auth: {
      signInWithOAuth: harness.signInWithOAuth,
      onAuthStateChange: () => ({ data: { subscription: {} } })
    }
  },
  getCarbon: () => ({}),
  isAuthProviderEnabled: (provider: string) => harness.providers.has(provider),
  safeRedirect: (to: unknown, fallback: string) =>
    typeof to === "string" && to.startsWith("/") && !to.startsWith("//")
      ? to
      : fallback,
  error: (details: unknown, message: string) => ({
    success: false,
    details,
    message
  })
}));
vi.mock("@carbon/auth/auth.server", () => ({
  refreshAccessToken: harness.refresh,
  verifyAuthSession: vi.fn(),
  logAuthEvent: vi.fn(),
  turnstileSiteKey: "synthetic-site-key"
}));
vi.mock("@carbon/auth/client.server", () => ({
  getCarbonServiceRole: () => ({})
}));
vi.mock("@carbon/auth/company.server", () => ({
  getCompanyId: () => null,
  setCompanyId: (companyId: string | null) =>
    `companyId=${companyId ?? ""}; Path=/`
}));
vi.mock("@carbon/auth/mfa.server", () => ({
  userHasVerifiedTotpFactor: harness.hasTotp
}));
vi.mock("@carbon/auth/users.server", () => ({ getUserByEmail: harness.user }));
vi.mock("@carbon/auth/verification.server", () => ({}));
vi.mock("@carbon/ee/sso.server", () => ({
  isSsoEnabled: () => false,
  isSsoRequiredForEmail: async () => false,
  deleteJitSsoUser: vi.fn(),
  getSsoConnectionByProviderId: vi.fn(),
  getSsoProviderIdFromSession: vi.fn(),
  linkSsoIdentityToUser: vi.fn(),
  migrateUserToSso: vi.fn()
}));
vi.mock("@carbon/kv", () => ({
  redis: { del: vi.fn() },
  Ratelimit: class {
    static slidingWindow() {
      return {};
    }
  },
  AccountLockout: class {
    reset = harness.lockoutReset;
  }
}));
vi.mock("@carbon/form", () => {
  const Box = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Hidden: Box,
    Input: Box,
    Submit: Box,
    ValidatedForm: Box,
    validator: () => ({
      validate: async (form: FormData) => ({
        data: {
          refreshToken: form.get("refreshToken"),
          userId: form.get("userId"),
          redirectTo: form.get("redirectTo") ?? undefined
        }
      })
    })
  };
});
vi.mock("@carbon/react", () => {
  const Box = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Alert: Box,
    AlertDescription: Box,
    AlertTitle: Box,
    Button: Box,
    Heading: Box,
    ItarLoginDisclaimer: Box,
    LoadingBars: Box,
    Separator: Box,
    TurnstileChallenge: Box,
    VStack: Box,
    toast: { error: vi.fn() },
    // Server rendering never runs effects, so capture every mount callback and
    // let the test fire them — twice, the way StrictMode replays effects.
    useMount: (callback: () => unknown) => {
      harness.mounts.push(callback);
    }
  };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") })
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => false,
  startAuthentication: vi.fn()
}));
vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
    useLoaderData: () => harness.loaderData,
    useSearchParams: () => [harness.searchParams],
    useFetcher: () => ({ data: undefined, state: "idle", submit: vi.fn() })
  };
});
vi.mock("~/modules/settings", () => ({
  getEmployeeCompanies: harness.employeeCompanies,
  getCompanies: harness.companies
}));
vi.mock("~/services/database.server", () => ({
  getDatabaseClient: () => ({})
}));

import {
  getAuthSession,
  getPendingMfaSession
} from "@carbon/auth/session.server";
import * as callback from "../app/routes/_public+/callback";
import * as login from "../app/routes/_public+/login";

const ORIGIN = "https://erp.example.com";
const REDIRECT_TO = "/x/portal?tab=1";

const authSession = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  userId: "user-1",
  companyId: "company-1",
  companyGroupId: "group-1",
  email: "user@example.com",
  expiresIn: 3600,
  expiresAt: 9_999_999_999
};

function loaderArgs(search: string) {
  return {
    request: new Request(`${ORIGIN}/login?${search}`),
    params: {},
    context: {}
  } as LoaderFunctionArgs;
}

function callbackArgs(fields: Record<string, string>) {
  return {
    request: new Request(`${ORIGIN}/callback`, {
      method: "POST",
      body: new URLSearchParams(fields)
    }),
    params: {},
    context: {}
  } as ActionFunctionArgs;
}

// Render the route as the server does, then replay every mount callback twice
// (StrictMode mounts, unmounts and re-mounts; the ref survives that) so the
// `autoGoogleStarted` guard is what keeps the OAuth start to one call.
async function mountLogin(loaderData: Record<string, unknown>, search: string) {
  harness.loaderData = loaderData;
  harness.searchParams = new URLSearchParams(search);
  harness.mounts = [];
  renderToStaticMarkup(createElement(login.default));
  const replayMounts = async () => {
    for (const mount of harness.mounts) {
      await mount();
    }
  };
  await replayMounts();
  await replayMounts();
}

function setCookies(response: Response) {
  return response.headers.getSetCookie();
}

function cookieHeaderFor(response: Response) {
  return setCookies(response)
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { origin: ORIGIN } });
  harness.providers = new Set(["google"]);
  harness.signInWithOAuth.mockResolvedValue({ error: null });
  harness.hasTotp.mockResolvedValue(false);
  harness.refresh.mockResolvedValue({ ...authSession });
  harness.user.mockResolvedValue({ data: { id: "user-1", active: true } });
  harness.employeeCompanies.mockResolvedValue({
    data: [{ companyId: "company-1", companyGroupId: "group-1" }]
  });
  harness.companies.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ERP workforce entry path", () => {
  it("starts Google OAuth once with the redirect target URL-encoded when Google is the only provider", async () => {
    const search = `workforce=google&redirectTo=${encodeURIComponent(REDIRECT_TO)}`;
    const loaderData = await login.loader(loaderArgs(search));
    expect(loaderData).toMatchObject({ autoGoogle: true, hasEmailAuth: false });

    await mountLogin(loaderData as Record<string, unknown>, search);

    expect(harness.signInWithOAuth).toHaveBeenCalledOnce();
    expect(harness.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: `${ORIGIN}/callback?redirectTo=${encodeURIComponent(REDIRECT_TO)}`
      }
    });
  });

  it("does not auto-start Google when email sign-in is also enabled", async () => {
    harness.providers.add("email");
    const search = "workforce=google";
    const loaderData = await login.loader(loaderArgs(search));
    expect(loaderData).toMatchObject({ autoGoogle: false, hasEmailAuth: true });

    await mountLogin(loaderData as Record<string, unknown>, search);

    expect(harness.signInWithOAuth).not.toHaveBeenCalled();
  });

  it("routes a user with a verified TOTP factor to /mfa, parking the redirect target", async () => {
    harness.hasTotp.mockResolvedValue(true);

    const response = (await callback.action(
      callbackArgs({
        refreshToken: "refresh-token",
        userId: "user-1",
        redirectTo: REDIRECT_TO
      })
    )) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/mfa");
    expect(harness.hasTotp).toHaveBeenCalledWith("user-1");

    const cookies = setCookies(response);
    const pending = cookies.find((cookie) => cookie.startsWith("carbon-erp="));
    expect(pending).toBeDefined();
    expect(pending).not.toMatch(/Domain=/);
    expect(pending).toMatch(/Secure/);

    // The pending cookie carries the first factor and the redirect target,
    // and nothing readable as a full session.
    const next = new Request(`${ORIGIN}/mfa`, {
      headers: { Cookie: cookieHeaderFor(response) }
    });
    expect(await getPendingMfaSession(next)).toMatchObject({
      authSession: { userId: "user-1", accessToken: "access-token" },
      redirectTo: REDIRECT_TO
    });
    expect(await getAuthSession(next)).toBeFalsy();
  });

  it("expires the legacy parent-domain cookie on every callback response", async () => {
    // The pre-split cookie was scoped to the parent domain; only a header
    // carrying that same Domain can clear it from the browser.
    const legacy =
      /^carbon=; Domain=example\.com; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax$/;

    harness.hasTotp.mockResolvedValue(true);
    const mfa = (await callback.action(
      callbackArgs({ refreshToken: "refresh-token", userId: "user-1" })
    )) as Response;
    expect(
      setCookies(mfa).filter((cookie) => legacy.test(cookie))
    ).toHaveLength(1);

    harness.hasTotp.mockResolvedValue(false);
    const full = (await callback.action(
      callbackArgs({
        refreshToken: "refresh-token",
        userId: "user-1",
        redirectTo: REDIRECT_TO
      })
    )) as Response;
    expect(full.status).toBe(302);
    expect(full.headers.get("Location")).toBe(REDIRECT_TO);
    expect(
      setCookies(full).filter((cookie) => legacy.test(cookie))
    ).toHaveLength(1);
    expect(
      setCookies(full).some((cookie) => cookie.startsWith("carbon-erp="))
    ).toBe(true);
  });
});
