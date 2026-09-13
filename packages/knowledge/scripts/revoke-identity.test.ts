import { describe, expect, it, vi } from "vitest";
import { IAP_ISSUER } from "../src/enrollment.server";
import {
  DATABASE_URL_VARIABLE,
  type EnrollmentDependencies
} from "./enroll-identity";
import { parseArguments, runRevocation } from "./revoke-identity";

const subject = "accounts.google.com:100000000000000000003";
const otherSubject = "accounts.google.com:100000000000000000004";
const localUrl =
  "postgresql://schema:synthetic-test-only@127.0.0.1:59930/knowledge_test";
const remoteUrl = "postgresql://schema:secret@db.example.com:5432/knowledge";

function unbound(companyId: string, bindingSubject: string, revocationVersion: number) {
  return {
    id: `kidn-${companyId}`,
    companyId,
    issuer: IAP_ISSUER,
    subject: bindingSubject,
    canonicalUserId: "bob",
    active: false,
    revocationVersion,
    version: revocationVersion,
    capabilities: ["knowledge.read"],
    createdBy: "bob",
    createdAt: "2026-09-11T00:00:00Z",
    updatedBy: "bob",
    updatedAt: "2026-09-11T00:00:00Z"
  };
}

function harness(
  options: {
    environment?: Record<string, string | undefined>;
    confirm?: boolean;
    users?: { id: string }[];
    bindings?: { issuer: string; subject: string; companyId: string }[];
    setRoleFails?: boolean;
    failWith?: Error;
  } = {}
) {
  let revocations = 0;
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    if (options.failWith) throw options.failWith;
    if (text === "SET ROLE knowledge_migrate") {
      if (options.setRoleFails) throw new Error("permission denied to set role");
      return { rows: [] };
    }
    if (text === "RESET ROLE") return { rows: [] };
    if (text.includes('FROM public."user"'))
      return { rows: options.users ?? [{ id: "bob" }] };
    if (text.includes('FROM knowledge."identityBinding"'))
      return { rows: options.bindings ?? [] };
    if (text.includes("knowledge.unbind_workforce_identity")) {
      revocations += 1;
      const [, bindingSubject, companyId] = values as [string, string, string];
      return { rows: [{ binding: unbound(companyId, bindingSubject, 1 + revocations) }] };
    }
    throw new Error(`unexpected query ${text}`);
  });
  const end = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ query, end }));
  const confirm = vi.fn<(question: string) => Promise<boolean>>(
    async () => options.confirm ?? false
  );
  const out: string[] = [];
  const err: string[] = [];
  const dependencies: EnrollmentDependencies = {
    environment: options.environment ?? { [DATABASE_URL_VARIABLE]: localUrl },
    connect: connect as unknown as EnrollmentDependencies["connect"],
    confirm,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line)
  };
  return { dependencies, query, end, connect, confirm, out, err };
}

function unbindCalls(query: ReturnType<typeof harness>["query"]) {
  return query.mock.calls
    .filter(([text]) => text.includes("knowledge.unbind_workforce_identity"))
    .map(([, values]) => values);
}

describe("parseArguments", () => {
  it("accepts a subject with its company, in space and equals forms", () => {
    expect(
      parseArguments(["--company=company-b", "--iap-subject", subject, "--allow-remote"])
    ).toEqual({
      mode: "subject",
      company: "company-b",
      iapSubject: subject,
      allowRemote: true
    });
  });

  it("accepts a user id or email, with the company optional", () => {
    expect(parseArguments(["--", "--user-id", "bob"])).toEqual({
      mode: "user",
      company: undefined,
      userId: "bob",
      userEmail: undefined,
      allowRemote: false
    });
    expect(
      parseArguments(["--user-email", "bob@example.com", "--company", "company-b"])
    ).toMatchObject({ mode: "user", userEmail: "bob@example.com", company: "company-b" });
  });

  it.each([
    ["no selector", ["--company", "company-b"]],
    ["two selectors", ["--iap-subject", subject, "--user-id", "bob"]],
    ["subject without company", ["--iap-subject", subject]],
    ["email-shaped subject", ["--company", "company-b", "--iap-subject", "bob@example.com"]],
    ["unknown option", ["--user-id", "bob", "--force"]],
    ["missing value", ["--user-id"]],
    ["repeated option", ["--user-id", "bob", "--user-id", "alice"]]
  ])("rejects %s", (_name, argv) => {
    expect(() => parseArguments(argv)).toThrow();
  });
});

describe("runRevocation", () => {
  it("revokes one subject and prints only the resulting revocation version", async () => {
    const h = harness();
    const code = await runRevocation(
      ["--company", "company-b", "--iap-subject", subject],
      h.dependencies
    );
    expect(code).toBe(0);
    expect(unbindCalls(h.query)).toEqual([[IAP_ISSUER, subject, "company-b"]]);
    expect(h.out).toEqual([
      "Revoke the binding for one subject in company company-b",
      "revocationVersion=2"
    ]);
    expect(h.out.join("\n")).not.toContain(subject);
    expect(h.out.join("\n")).not.toContain("kidn-");
    expect(h.err).toEqual([]);
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it("revokes every binding of a user under the migrate role and reports one version per binding", async () => {
    const h = harness({
      bindings: [
        { issuer: IAP_ISSUER, subject, companyId: "company-a" },
        { issuer: IAP_ISSUER, subject: otherSubject, companyId: "company-b" }
      ]
    });
    const code = await runRevocation(["--user-email", "bob@example.com"], h.dependencies);
    expect(code).toBe(0);
    const texts = h.query.mock.calls.map(([text]) => text);
    expect(texts.indexOf("SET ROLE knowledge_migrate")).toBeGreaterThan(
      texts.findIndex((text) => text.includes('FROM public."user"'))
    );
    expect(texts).toContain("RESET ROLE");
    expect(unbindCalls(h.query)).toEqual([
      [IAP_ISSUER, subject, "company-a"],
      [IAP_ISSUER, otherSubject, "company-b"]
    ]);
    expect(h.out).toEqual([
      "Revoke 2 binding(s) of one user",
      "revocationVersion=2",
      "revocationVersion=3"
    ]);
    for (const identifying of [subject, otherSubject, "bob", "kidn-"]) {
      expect(h.out.join("\n")).not.toContain(identifying);
    }
  });

  it("passes the company filter through and fails when the user has no bindings", async () => {
    const h = harness();
    const code = await runRevocation(
      ["--user-id", "bob", "--company", "company-b"],
      h.dependencies
    );
    expect(code).toBe(1);
    const listing = h.query.mock.calls.find(([text]) =>
      text.includes('FROM knowledge."identityBinding"')
    );
    expect(listing?.[1]).toEqual(["bob", "company-b"]);
    expect(unbindCalls(h.query)).toEqual([]);
    expect(h.err).toEqual(["No bindings exist for that user; nothing to revoke"]);
  });

  it("explains when the connection cannot list bindings, without writing", async () => {
    const h = harness({ setRoleFails: true });
    const code = await runRevocation(["--user-id", "bob"], h.dependencies);
    expect(code).toBe(1);
    expect(unbindCalls(h.query)).toEqual([]);
    expect(h.err[0]).toMatch(/SET ROLE knowledge_migrate/);
    expect(h.err[0]).toMatch(/--iap-subject/);
  });

  it("refuses a remote database without --allow-remote and aborts when not confirmed", async () => {
    const refused = harness({ environment: { [DATABASE_URL_VARIABLE]: remoteUrl } });
    expect(
      await runRevocation(["--company", "company-b", "--iap-subject", subject], refused.dependencies)
    ).toBe(2);
    expect(refused.connect).not.toHaveBeenCalled();

    const aborted = harness({
      environment: { [DATABASE_URL_VARIABLE]: remoteUrl },
      confirm: false
    });
    expect(
      await runRevocation(
        ["--company", "company-b", "--iap-subject", subject, "--allow-remote"],
        aborted.dependencies
      )
    ).toBe(1);
    expect(aborted.confirm).toHaveBeenCalledTimes(1);
    expect(unbindCalls(aborted.query)).toEqual([]);
    expect(aborted.err).toEqual(["Aborted; nothing was written"]);

    const confirmed = harness({
      environment: { [DATABASE_URL_VARIABLE]: remoteUrl },
      confirm: true
    });
    expect(
      await runRevocation(
        ["--company", "company-b", "--iap-subject", subject, "--allow-remote"],
        confirmed.dependencies
      )
    ).toBe(0);
    expect(confirmed.out).toEqual(["revocationVersion=2"]);
  });

  it("reports a database failure by its primary message only", async () => {
    const h = harness({
      failWith: Object.assign(new Error("no binding exists for that subject in this company"), {
        detail: `Key (subject)=(${subject})`
      })
    });
    expect(
      await runRevocation(["--company", "company-b", "--iap-subject", subject], h.dependencies)
    ).toBe(1);
    expect(h.err).toEqual([
      "Revocation failed: no binding exists for that subject in this company"
    ]);
    expect(h.err.join("\n")).not.toContain(subject);
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it("requires the database URL and usage on bad arguments", async () => {
    const missing = harness({ environment: {} });
    expect(await runRevocation(["--user-id", "bob"], missing.dependencies)).toBe(2);
    expect(missing.err[0]).toContain(DATABASE_URL_VARIABLE);

    const usage = harness();
    expect(await runRevocation(["--company", "company-b"], usage.dependencies)).toBe(2);
    expect(usage.err[0]).toContain("usage: revoke-identity");
    expect(usage.connect).not.toHaveBeenCalled();
  });
});
