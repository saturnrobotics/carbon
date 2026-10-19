import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oauth = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  toastError: vi.fn()
}));

// No Supabase client, UI library, or browser: only the sign-in request and
// the automatic-start guard are under test.
vi.mock("../lib/supabase/client", () => ({
  carbonClient: { auth: { signInWithOAuth: oauth.signInWithOAuth } }
}));
vi.mock("@carbon/react", () => ({
  Button: () => null,
  toast: { error: oauth.toastError },
  useMount: vi.fn()
}));

import {
  claimHqAutoStart,
  HQ_OAUTH_PROVIDER,
  signInWithHq
} from "./hq-sign-in";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values
  } as unknown as Storage & { values: Map<string, string> };
}

const KEY = "carbon:hq-sign-in:auto-started";

describe("signInWithHq", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      location: { origin: "https://erp.example.com" }
    });
    oauth.signInWithOAuth.mockResolvedValue({ error: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses GoTrue's Keycloak provider and Carbon's own callback", async () => {
    await signInWithHq("/x/parts/part.rev?tab=1");
    expect(HQ_OAUTH_PROVIDER).toBe("keycloak");
    expect(oauth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "keycloak",
      options: {
        redirectTo:
          "https://erp.example.com/callback?redirectTo=%2Fx%2Fparts%2Fpart.rev%3Ftab%3D1",
        scopes: "profile email"
      }
    });
    expect(oauth.toastError).not.toHaveBeenCalled();
  });

  it("returns to the bare callback without a destination", async () => {
    await signInWithHq();
    expect(oauth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "keycloak",
      options: {
        redirectTo: "https://erp.example.com/callback",
        scopes: "profile email"
      }
    });
  });

  it("reports a refused start instead of failing silently", async () => {
    oauth.signInWithOAuth.mockResolvedValue({
      error: { message: "Unsupported provider: provider is not enabled" }
    });
    await signInWithHq();
    expect(oauth.toastError).toHaveBeenCalledWith(
      "Unsupported provider: provider is not enabled"
    );
  });
});

describe("claimHqAutoStart", () => {
  it("starts once, then shows the button when sign-in bounces straight back", () => {
    const storage = memoryStorage();
    expect(claimHqAutoStart(storage, 1_000_000)).toBe(true);
    expect(storage.values.get(KEY)).toBe("1000000");
    expect(claimHqAutoStart(storage, 1_000_000 + 59_999)).toBe(false);
    expect(storage.values.get(KEY)).toBe("1000000");
  });

  it("starts again once the previous attempt is older than the window", () => {
    const storage = memoryStorage({ [KEY]: "1000000" });
    expect(claimHqAutoStart(storage, 1_000_000 + 60_000)).toBe(true);
    expect(storage.values.get(KEY)).toBe("1060000");
  });

  it("ignores unreadable or future stored values", () => {
    for (const stored of ["", "not-a-number", "-5", "9000000"]) {
      expect(
        claimHqAutoStart(memoryStorage({ [KEY]: stored }), 1_000_000)
      ).toBe(true);
    }
  });

  it("never starts automatically when storage is unavailable", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      }
    } as unknown as Storage;
    expect(claimHqAutoStart(blocked, 1_000_000)).toBe(false);
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      }
    } as unknown as Storage;
    expect(claimHqAutoStart(full, 1_000_000)).toBe(false);
  });
});
