import { describe, expect, it } from "vitest";
import { isPortalWebReady } from "./health";

const configured = {
  PORTAL_COMPANY_ID: "company-example",
  PORTAL_MANUAL_SOURCE_JSON:
    '{"sourceId":"manuals","displayName":"Manual library"}',
  PORTAL_QUERY_AUDIENCE: "query-audience",
  PORTAL_QUERY_URL: "https://query.example",
  PORTAL_RELEASE_PROFILE: "manual-v1",
  PORTAL_WEB_IAP_AUDIENCE: "iap-audience",
  PORTAL_WEB_ORIGIN: "https://manuals.example",
  PORTAL_WORKER_AUDIENCE: "worker-audience",
  PORTAL_WORKER_URL: "https://worker.example"
};

describe("manual-v1 web readiness", () => {
  it("fails closed for missing or deferred release profiles", () => {
    expect(isPortalWebReady(configured)).toBe(true);
    expect(isPortalWebReady({ ...configured, PORTAL_WORKER_URL: "" })).toBe(
      false
    );
    expect(
      isPortalWebReady({
        ...configured,
        PORTAL_RELEASE_PROFILE: "platform"
      })
    ).toBe(false);
  });
});
