import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  providers: new Set<string>(),
  sso: false,
  session: vi.fn(),
  verifySession: vi.fn(),
  clearCookies: vi.fn(),
  captcha: vi.fn(),
  user: vi.fn(),
  send: vi.fn(),
  limit: vi.fn(),
  lockStatus: vi.fn(),
  recordAttempt: vi.fn(),
  ssoRequired: vi.fn()
}));

// Keep real route control flow and HTTP responses; isolate identity, email,
// captcha, and Redis so no running service or deployment credentials are used.
vi.mock("@carbon/auth", () => ({
  assertIsPost: (request: Request) => {
    if (request.method !== "POST") throw new Error("Expected POST");
  },
  CarbonEdition: "Enterprise",
  CARBON_API_URL: "https://api.example.com",
  SUPABASE_URL: "https://database.example.com",
  getAppUrl: () => "https://erp.example.com",
  getMESUrl: () => "https://mes.example.com",
  isAuthProviderEnabled: (provider: string) => auth.providers.has(provider),
  magicLinkValidator: {},
  RATE_LIMIT: 5,
  error: (details: unknown, message: string) => ({
    success: false,
    details,
    message
  })
}));
vi.mock("@carbon/auth/auth.server", () => ({
  turnstileSiteKey: "synthetic-site-key",
  verifyAuthSession: auth.verifySession,
  verifyLoginCaptcha: auth.captcha,
  sendMagicLink: auth.send,
  logAuthEvent: vi.fn(),
  getMagicLinkErrorMessage: () => "Failed to send magic link"
}));
vi.mock("@carbon/auth/client.server", () => ({
  getCarbonServiceRole: () => ({})
}));
vi.mock("@carbon/auth/session.server", () => ({
  getAuthSession: auth.session,
  clearAuthCookies: auth.clearCookies,
  flash: async () => ({})
}));
vi.mock("@carbon/auth/users.server", () => ({ getUserByEmail: auth.user }));
vi.mock("@carbon/auth/verification.server", () => ({}));
vi.mock("@carbon/ee/sso.server", () => ({
  isSsoEnabled: () => auth.sso,
  isSsoRequiredForEmail: auth.ssoRequired
}));
vi.mock("@carbon/kv", () => ({
  redis: {},
  Ratelimit: class {
    static slidingWindow() {
      return {};
    }
    limit = auth.limit;
  },
  AccountLockout: class {
    status = auth.lockStatus;
    recordFailure = auth.recordAttempt;
  }
}));
vi.mock("@carbon/form", () => ({
  validator: () => ({
    validate: async (form: FormData) => ({
      data: {
        email: form.get("email"),
        turnstileToken: form.get("turnstileToken")
      }
    })
  })
}));
vi.mock("@carbon/react", () => ({}));
vi.mock("@carbon/utils", () => ({ Edition: { Enterprise: "Enterprise" } }));
vi.mock("@lingui/react/macro", () => ({}));
vi.mock("@simplewebauthn/browser", () => ({}));

import * as mes from "../../mes/app/routes/_public+/login";
import * as erp from "../app/routes/_public+/login";

function loaderArgs() {
  return {
    request: new Request("https://erp.example.com/login?workforce=google"),
    params: {},
    context: {}
  } as LoaderFunctionArgs;
}

function actionArgs() {
  return {
    request: new Request("https://erp.example.com/login", {
      method: "POST",
      headers: { "x-forwarded-for": "192.0.2.1" },
      body: new URLSearchParams({
        email: "user@example.com",
        turnstileToken: "synthetic-captcha-token"
      })
    }),
    params: {},
    context: {}
  } as ActionFunctionArgs;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEV_BYPASS_EMAIL", "");
  auth.providers = new Set(["google"]);
  auth.sso = false;
  auth.session.mockResolvedValue(null);
  auth.verifySession.mockResolvedValue(false);
  auth.clearCookies.mockResolvedValue({ "Set-Cookie": "carbon=; Max-Age=0" });
  auth.limit.mockResolvedValue({ success: true });
  auth.lockStatus.mockResolvedValue({ locked: false });
  auth.recordAttempt.mockResolvedValue({ locked: false });
  auth.captcha.mockResolvedValue(null);
  auth.ssoRequired.mockResolvedValue(false);
  auth.user.mockResolvedValue({ data: { active: true } });
  auth.send.mockResolvedValue({ error: null });
});

afterEach(() => vi.unstubAllEnvs());

describe.each([
  { app: "ERP", route: erp },
  { app: "MES", route: mes }
])("$app merged login", ({ route }) => {
  it("retains Google-only workforce entry and the configured captcha key", async () => {
    expect(await route.loader(loaderArgs())).toMatchObject({
      hasEmailAuth: false,
      hasGoogleAuth: true,
      autoGoogle: true,
      turnstileSiteKey: "synthetic-site-key"
    });
  });

  it("retains provider and captcha configuration when clearing an expired session", async () => {
    auth.session.mockResolvedValue({ accessToken: "expired-test-token" });
    expect(await route.loader(loaderArgs())).toMatchObject({
      data: {
        hasEmailAuth: false,
        hasGoogleAuth: true,
        autoGoogle: true,
        turnstileSiteKey: "synthetic-site-key"
      },
      init: { headers: { "Set-Cookie": "carbon=; Max-Age=0" } }
    });
    expect(auth.clearCookies).toHaveBeenCalledOnce();
  });

  it("does not auto-select Google when email is also enabled", async () => {
    auth.providers.add("email");
    expect(await route.loader(loaderArgs())).toMatchObject({
      hasEmailAuth: true,
      autoGoogle: false,
      turnstileSiteKey: "synthetic-site-key"
    });
  });

  it("rejects disabled email sign-in before captcha or user lookup", async () => {
    expect(await route.action(actionArgs())).toMatchObject({
      data: { success: false, message: "Email sign-in is disabled" },
      init: { status: 403 }
    });
    expect(auth.limit).toHaveBeenCalledOnce();
    expect(auth.captcha).not.toHaveBeenCalled();
    expect(auth.user).not.toHaveBeenCalled();
    expect(auth.send).not.toHaveBeenCalled();
  });

  it("rejects failed captcha before looking up a user or sending email", async () => {
    auth.providers.add("email");
    auth.captcha.mockResolvedValue(
      "Bot verification failed. Please try again."
    );
    expect(await route.action(actionArgs())).toMatchObject({
      data: {
        success: false,
        message: "Bot verification failed. Please try again."
      }
    });
    expect(auth.captcha).toHaveBeenCalledWith(
      "synthetic-captcha-token",
      "192.0.2.1"
    );
    expect(auth.user).not.toHaveBeenCalled();
    expect(auth.send).not.toHaveBeenCalled();
  });

  it("forwards the accepted captcha token for enabled email sign-in", async () => {
    auth.providers.add("email");
    expect(await route.action(actionArgs())).toMatchObject({ success: true });
    expect(auth.captcha).toHaveBeenCalledWith(
      "synthetic-captcha-token",
      "192.0.2.1"
    );
    expect(auth.send).toHaveBeenCalledWith(
      "user@example.com",
      "synthetic-captcha-token"
    );
  });
});
