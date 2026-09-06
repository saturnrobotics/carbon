import {
  isMercuryAttachmentPath,
  parseMercuryInvoiceEvidence
} from "@carbon/database/mercury";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mercuryApprovalValidator,
  mercurySettingsValidator
} from "./invoicing.models";
import {
  assertMercuryRequestOrigin,
  getMercuryConnectionStatus
} from "./mercury.server";

afterEach(() => vi.unstubAllEnvs());

describe("Mercury connection visibility", () => {
  const accounts = [
    {
      email: "invoices@example.com",
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      refreshToken: "synthetic-refresh",
      enabled: true
    }
  ];

  it("never returns bank or mailbox secrets to the page", () => {
    vi.stubEnv("PAYMENT_SYNC_COMPANY_ID", "company-a");
    vi.stubEnv("MERCURY_API_TOKEN", "synthetic-bank-secret");
    vi.stubEnv("GMAIL_ACCOUNTS_JSON", JSON.stringify(accounts));
    const result = getMercuryConnectionStatus("company-a");
    expect(result.mercuryReady).toBe(true);
    expect(result.mailboxes).toEqual([
      { email: "invoices@example.com", enabled: true }
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic");
  });

  it("hides connection and mailbox details from another company", () => {
    vi.stubEnv("PAYMENT_SYNC_COMPANY_ID", "company-a");
    vi.stubEnv("MERCURY_API_TOKEN", "synthetic-bank-secret");
    vi.stubEnv("GMAIL_ACCOUNTS_JSON", JSON.stringify(accounts));
    expect(getMercuryConnectionStatus("company-b")).toEqual({
      isBound: false,
      mercuryReady: false,
      mailboxes: [],
      gmailConfigurationError: false
    });
  });

  it("reports invalid mailbox configuration without returning its contents", () => {
    vi.stubEnv("PAYMENT_SYNC_COMPANY_ID", "company-a");
    vi.stubEnv("GMAIL_ACCOUNTS_JSON", "synthetic-secret-invalid-json");
    const result = getMercuryConnectionStatus("company-a");
    expect(result.gmailConfigurationError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
});

describe("Mercury review boundaries", () => {
  it("rejects cookie-authenticated changes from sibling and foreign origins", () => {
    vi.stubEnv("ERP_URL", "https://erp.example.com");
    const url = "http://localhost:3000/x/invoicing/mercury";
    expect(() =>
      assertMercuryRequestOrigin(
        new Request(url, {
          method: "POST",
          headers: { Origin: "https://erp.example.com" }
        })
      )
    ).not.toThrow();
    for (const origin of [
      "https://mail.example.com",
      "https://other.example",
      "null",
      ""
    ]) {
      expect(() =>
        assertMercuryRequestOrigin(
          new Request(url, {
            method: "POST",
            headers: { Origin: origin }
          })
        )
      ).toThrow();
    }
  });
  it("restricts attachment copies to the current company's import folder", () => {
    expect(
      isMercuryAttachmentPath("company-a", "company-a/mercury/payment/file.pdf")
    ).toBe(true);
    for (const path of [
      "company-b/mercury/file.pdf",
      "company-a/private/file.pdf",
      "company-a/mercury/../payroll.pdf",
      "company-a/mercury/a\\b.pdf",
      "company-a/mercury/file\u0000.pdf"
    ]) {
      expect(isMercuryAttachmentPath("company-a", path)).toBe(false);
    }
  });

  it("does not interpret arbitrary mailbox response objects as invoice evidence", () => {
    expect(
      parseMercuryInvoiceEvidence({ access_token: "synthetic-secret" })
    ).toEqual([]);
  });

  it("requires confirmation of a supplier before creating an invoice", () => {
    expect(
      mercuryApprovalValidator.safeParse({ importId: "import-a" }).success
    ).toBe(false);
    expect(
      mercuryApprovalValidator.safeParse({
        importId: "import-a",
        supplierId: "supplier-a"
      }).success
    ).toBe(true);
    expect(
      mercuryApprovalValidator.safeParse({
        importId: "import-a",
        purchaseInvoiceId: "invoice-a"
      }).success
    ).toBe(true);
    expect(
      mercuryApprovalValidator.safeParse({
        importId: "import-a",
        supplierName: "Example Parts"
      }).success
    ).toBe(true);
    expect(
      mercuryApprovalValidator.safeParse({
        importId: "import-a",
        supplierName: " ",
        supplierEmail: "invalid"
      }).success
    ).toBe(false);
  });

  it("permits pausing all sync and preserves multiple mailbox pause selections", () => {
    const parsed = mercurySettingsValidator.parse({
      disabledMailboxes: ["invoices@example.com", "purchasing@example.com"],
      syncFromDate: ""
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.disabledMailboxes).toHaveLength(2);
    expect(parsed.syncFromDate).toBeUndefined();
  });
});
