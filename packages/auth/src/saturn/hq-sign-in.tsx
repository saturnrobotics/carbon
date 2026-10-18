// Saturn fork: sign in through the HQ identity provider.
//
// `hq` in AUTH_PROVIDERS is GoTrue's built-in Keycloak provider pointed at HQ's
// Keycloak-compatible OpenID provider (see
// contrib/deploying/gcp-tailscale/hq_sign_in.py). HQ returns to Carbon's
// ordinary /callback, which matches the account by email like every OAuth login.
import { Button, toast, useMount } from "@carbon/react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { carbonClient } from "../lib/supabase/client";

/** The Supabase provider behind `hq` in AUTH_PROVIDERS. */
export const HQ_OAUTH_PROVIDER = "keycloak";

const AUTO_START_KEY = "carbon:hq-sign-in:auto-started";
const AUTO_START_WINDOW_MS = 60_000;

export async function signInWithHq(redirectTo?: string) {
  const { error } = await carbonClient.auth.signInWithOAuth({
    provider: HQ_OAUTH_PROVIDER,
    options: {
      redirectTo: `${window.location.origin}/callback${
        redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ""
      }`,
      scopes: "profile email"
    }
  });

  if (error) {
    toast.error(error.message);
  }
}

/**
 * Claims this tab's automatic start. A second automatic start within the window
 * means the last attempt came straight back to /login (HQ or Carbon refused
 * it), so the person gets the button and the error instead of a redirect loop.
 * Without session storage nothing starts automatically.
 */
export function claimHqAutoStart(storage: Storage, now: number) {
  try {
    const last = Number(storage.getItem(AUTO_START_KEY));
    if (last > 0 && last <= now && now - last < AUTO_START_WINDOW_MS) {
      return false;
    }
    storage.setItem(AUTO_START_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/** Starts HQ sign-in on mount when `auto` (HQ is the only provider). */
export function useHqAutoStart(auto: boolean, redirectTo?: string) {
  const started = useRef(false);
  useMount(() => {
    if (!auto || started.current) return;
    started.current = true;
    let storage: Storage;
    try {
      storage = window.sessionStorage;
    } catch {
      return;
    }
    if (claimHqAutoStart(storage, Date.now())) {
      void signInWithHq(redirectTo);
    }
  });
}

export function HqSignInButton({
  children,
  isDisabled,
  redirectTo
}: {
  children: ReactNode;
  isDisabled?: boolean;
  redirectTo?: string;
}) {
  return (
    <Button
      type="button"
      size="lg"
      className="w-full"
      onClick={() => signInWithHq(redirectTo)}
      isDisabled={isDisabled}
    >
      {children}
    </Button>
  );
}
