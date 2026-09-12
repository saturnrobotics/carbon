import { describe, expect, it, vi } from "vitest";
import {
  EnrollmentInputError,
  enrollWorkforceIdentity,
  IAP_ISSUER,
  isIapSubject,
  normalizeCapabilities,
  unbindWorkforceIdentity
} from "./enrollment.server";

const subject = "accounts.google.com:100000000000000000001";

const bindingRow = {
  id: "kidn-synthetic",
  companyId: "company-a",
  issuer: IAP_ISSUER,
  subject,
  canonicalUserId: "alice",
  active: true,
  revocationVersion: 1,
  version: 1,
  capabilities: ["knowledge.read"],
  createdBy: "alice",
  createdAt: "2026-09-11T00:00:00Z",
  updatedBy: null,
  updatedAt: null
};

function fakeDatabase(rows: unknown[] = [{ binding: bindingRow }]) {
  return {
    query: vi.fn(async () => ({ rows }))
  };
}

describe("isIapSubject", () => {
  it.each([
    "accounts.google.com:1",
    "accounts.google.com:100000000000000000001"
  ])("accepts the IAP subject shape %s", (value) => {
    expect(isIapSubject(value)).toBe(true);
  });

  it.each([
    "alice@example.com",
    "accounts.google.com:alice@example.com",
    "subject-a",
    "accounts.google.com:",
    "accounts.google.com:12a",
    " accounts.google.com:1",
    ""
  ])("rejects %j", (value) => {
    expect(isIapSubject(value)).toBe(false);
  });
});

describe("normalizeCapabilities", () => {
  it("deduplicates, trims and sorts", () => {
    expect(
      normalizeCapabilities([
        "source.entities.search",
        " knowledge.read ",
        "knowledge.read",
        ""
      ])
    ).toEqual(["knowledge.read", "source.entities.search"]);
  });

  it("refuses an empty list", () => {
    expect(() => normalizeCapabilities([])).toThrow(EnrollmentInputError);
    expect(() => normalizeCapabilities(["", " "])).toThrow(
      EnrollmentInputError
    );
  });

  it.each([
    "Knowledge.Read",
    "knowledge",
    "knowledge..read",
    "1.read"
  ])("refuses a malformed capability %s", (value) => {
    expect(() => normalizeCapabilities([value])).toThrow(EnrollmentInputError);
  });
});

describe("enrollWorkforceIdentity", () => {
  it("calls the owner function with normalized input and the IAP issuer by default", async () => {
    const db = fakeDatabase();
    const binding = await enrollWorkforceIdentity(db, {
      subject,
      companyId: "company-a",
      userId: "alice",
      capabilities: ["source.entities.search", "knowledge.read"]
    });
    expect(binding).toEqual(bindingRow);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0] as unknown as [
      string,
      unknown[]
    ];
    expect(sql).toContain("knowledge.enroll_workforce_identity(");
    expect(values).toEqual([
      IAP_ISSUER,
      subject,
      "company-a",
      "alice",
      ["knowledge.read", "source.entities.search"]
    ]);
  });

  it("refuses an email-shaped subject before any database call", async () => {
    const db = fakeDatabase();
    await expect(
      enrollWorkforceIdentity(db, {
        subject: "alice@example.com",
        companyId: "company-a",
        userId: "alice",
        capabilities: ["knowledge.read"]
      })
    ).rejects.toBeInstanceOf(EnrollmentInputError);
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    { companyId: "", userId: "alice" },
    { companyId: "company-a", userId: "" }
  ])("refuses missing identifiers %j", async (input) => {
    const db = fakeDatabase();
    await expect(
      enrollWorkforceIdentity(db, {
        subject,
        capabilities: ["knowledge.read"],
        ...input
      })
    ).rejects.toBeInstanceOf(EnrollmentInputError);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects a malformed function result instead of trusting it", async () => {
    const db = fakeDatabase([{ binding: { id: "x" } }]);
    await expect(
      enrollWorkforceIdentity(db, {
        subject,
        companyId: "company-a",
        userId: "alice",
        capabilities: ["knowledge.read"]
      })
    ).rejects.toThrow("unexpected row");
  });
});

describe("unbindWorkforceIdentity", () => {
  it("calls the owner function with issuer, subject and company", async () => {
    const db = fakeDatabase([
      { binding: { ...bindingRow, active: false, revocationVersion: 2 } }
    ]);
    const binding = await unbindWorkforceIdentity(db, {
      subject,
      companyId: "company-a"
    });
    expect(binding.active).toBe(false);
    expect(binding.revocationVersion).toBe(2);
    const [sql, values] = db.query.mock.calls[0] as unknown as [
      string,
      unknown[]
    ];
    expect(sql).toContain("knowledge.unbind_workforce_identity(");
    expect(values).toEqual([IAP_ISSUER, subject, "company-a"]);
  });

  it("refuses an empty subject before any database call", async () => {
    const db = fakeDatabase();
    await expect(
      unbindWorkforceIdentity(db, { subject: "", companyId: "company-a" })
    ).rejects.toBeInstanceOf(EnrollmentInputError);
    expect(db.query).not.toHaveBeenCalled();
  });
});
