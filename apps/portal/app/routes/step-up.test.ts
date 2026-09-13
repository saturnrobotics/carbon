import { describe, expect, it } from "vitest";
import { carbonLoginUrl } from "../services/step-up.server";

describe("step-up page", () => {
  it("offers the configured Carbon login link only when it is a bare https URL", () => {
    expect(
      carbonLoginUrl({
        PORTAL_CARBON_LOGIN_URL: "https://erp.example/login"
      })
    ).toBe("https://erp.example/login");
    expect(
      carbonLoginUrl({
        PORTAL_CARBON_LOGIN_URL: "  https://erp.example/login  "
      })
    ).toBe("https://erp.example/login");
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["http", "http://erp.example/login"],
    ["credentials", "https://user:pw@erp.example/login"],
    ["a query", "https://erp.example/login?redirectTo=/x"],
    ["a fragment", "https://erp.example/login#mfa"],
    ["not a URL", "erp.example/login"]
  ])("renders no link when the login URL is %s", (_name, value) => {
    expect(
      carbonLoginUrl(
        value === undefined ? {} : { PORTAL_CARBON_LOGIN_URL: value }
      )
    ).toBeNull();
  });

  it("answers with 403 so the page is never mistaken for a successful read", async () => {
    const { loader } = await import("./step-up");
    const response = loader();
    expect(response.init?.status).toBe(403);
    expect(response.data).toEqual({ loginUrl: null });
  });
});
