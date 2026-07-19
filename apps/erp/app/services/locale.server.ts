import { DOMAIN, shouldUseSecureCookie } from "@carbon/auth";
import { localeCookieName, resolveLanguage } from "@carbon/locale";
import * as cookie from "cookie";

export function setLocale(locale: string) {
  const cookieOptions: cookie.SerializeOptions = {
    path: "/",
    sameSite: "lax",
    secure: shouldUseSecureCookie(DOMAIN),
    maxAge: 31536000
  };

  return cookie.serialize(
    localeCookieName,
    resolveLanguage(locale),
    cookieOptions
  );
}
