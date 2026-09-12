/**
 * The portal keeps no session of its own: the browser is authenticated by
 * IAP on every request. Signing out therefore means two things — clearing the
 * IAP login cookie (Google's documented `gcp-iap-mode=CLEAR_LOGIN_COOKIE`
 * handler on this origin) and clearing every private artifact the browser may
 * still hold for this origin: DOM storage, IndexedDB, service worker
 * registrations and the HTTP cache. `Clear-Site-Data` does the latter before
 * the redirect is followed, so the next person at this browser starts from
 * nothing, whichever company or user they sign in as.
 */
export const IAP_CLEAR_LOGIN_COOKIE_PATH = "/?gcp-iap-mode=CLEAR_LOGIN_COOKIE";
export const CLEAR_SITE_DATA = '"cache", "storage"';

export function logoutResponse(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: IAP_CLEAR_LOGIN_COOKIE_PATH,
      "clear-site-data": CLEAR_SITE_DATA,
      "cache-control": "private, no-store",
      vary: "cookie, authorization"
    }
  });
}

export function loader() {
  return logoutResponse();
}

export function action() {
  return logoutResponse();
}
