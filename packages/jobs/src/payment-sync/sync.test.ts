import { describe, expect, it, vi } from "vitest";
import { parseGmailAccounts } from "./config";
import { ProviderError } from "./providers";
import { providerErrorCode, storeAttachment } from "./sync";

describe("private payment import boundaries", () => {
  it("does not expose malformed credentials in configuration errors", () => {
    expect(() => parseGmailAccounts("synthetic-secret-token")).toThrow(
      "gmail_configuration_invalid"
    );
    const account = {
      email: "billing@example.com",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      enabled: true
    };
    expect(() =>
      parseGmailAccounts(JSON.stringify([account, account]))
    ).toThrow("gmail_configuration_invalid");
    expect(parseGmailAccounts(undefined)).toEqual([]);
  });

  it("stores only safe provider failure codes", () => {
    expect(providerErrorCode(new Error("Authorization: secret-token"))).toBe(
      "sync_failed"
    );
    expect(
      providerErrorCode(new ProviderError("Gmail", "request_failed", 401))
    ).toBe("gmail_request_failed_401");
  });

  it("uses stable private content addresses and never writes HTML attachments", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ upload });
    const context = {
      companyId: "company_example",
      storage: { from } as unknown as Parameters<
        typeof storeAttachment
      >[0]["storage"]
    };
    const pdf = new TextEncoder().encode("%PDF-1.4 synthetic invoice");
    const first = await storeAttachment(
      context,
      "transaction_example",
      "../invoice.pdf",
      pdf,
      { source: "mercury" }
    );
    const second = await storeAttachment(
      context,
      "transaction_example",
      "invoice.pdf",
      pdf,
      { source: "mercury" }
    );
    expect(first.path).toBe(second.path);
    expect(first.path).toMatch(
      /^company_example\/mercury\/[a-f0-9]{64}\/[a-f0-9]{64}\.pdf$/
    );
    expect(from).toHaveBeenCalledWith("private");
    expect(upload).toHaveBeenCalledWith(first.path, pdf, {
      contentType: "application/pdf",
      upsert: true
    });
    await expect(
      storeAttachment(
        context,
        "transaction_example",
        "invoice.html",
        new TextEncoder().encode("<script>fetch('/private')</script>"),
        { source: "gmail" }
      )
    ).rejects.toThrow("unsupported_file");
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
