import { describe, expect, it } from "vitest";
import { validateFetchUrl } from "./fetch-policy";

describe("validateFetchUrl", () => {
  it("allows HTTPS public documents and rejects SSRF targets", () => {
    expect(
      validateFetchUrl("https://docs.example.com/manual.pdf").hostname
    ).toBe("docs.example.com");
    expect(() => validateFetchUrl("http://127.0.0.1/admin")).toThrow("HTTPS");
    expect(() =>
      validateFetchUrl("https://169.254.169.254/latest/meta-data")
    ).toThrow("private");
    expect(() => validateFetchUrl("https://localhost/manual.pdf")).toThrow(
      "private"
    );
  });
});
