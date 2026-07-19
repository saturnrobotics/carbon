import { DOMAIN, shouldUseSecureCookie } from "@carbon/auth";
import type { Mode } from "@carbon/utils";
import * as cookie from "cookie";

const cookieName = "mode";

export function getMode(request: Request): Mode | null {
  const cookieHeader = request.headers.get("cookie");
  const parsed = cookieHeader
    ? cookie.parse(cookieHeader)[cookieName]
    : "light";
  if (parsed === "light" || parsed === "dark") return parsed;
  return null;
}

export function setMode(mode: Mode | "system") {
  const cookieOptions: cookie.SerializeOptions = {
    path: "/",
    sameSite: "lax",
    secure: shouldUseSecureCookie(DOMAIN),
    maxAge: mode === "system" ? -1 : 31536000
  };

  return cookie.serialize(
    cookieName,
    mode === "system" ? "" : mode,
    cookieOptions
  );
}
