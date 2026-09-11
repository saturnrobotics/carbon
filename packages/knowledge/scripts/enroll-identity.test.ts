import { describe, expect, it, vi } from "vitest";
import { IAP_ISSUER } from "../src/enrollment.server";
import {
  DATABASE_URL_VARIABLE,
  type EnrollmentDependencies,
  isLocalDatabaseUrl,
  parseArguments,
  runEnrollment
} from "./enroll-identity";

const subject = "accounts.google.com:100000000000000000002";
const localUrl =
  "postgresql://schema:synthetic-test-only@127.0.0.1:59930/knowledge_test";
const remoteUrl = "postgresql://schema:secret@db.example.com:5432/knowledge";

const binding = {
  id: "kidn-synthetic",
  companyId: "company-b",
  issuer: IAP_ISSUER,
  subject,
  canonicalUserId: "bob",
  active: true,
  revocationVersion: 1,
  version: 1,
  capabilities: ["knowledge.read"],
  createdBy: "bob",
  createdAt: "2026-09-11T00:00:00Z",
  updatedBy: null,
  updatedAt: null
};

function harness(options: {
  environment?: Record<string, string | undefined>;
  confirm?: boolean;
  users?: { id: string }[];
  failWith?: Error;
} = {}) {
  const query = vi.fn(async (text: string) => {
    if (options.failWith) throw options.failWith;
    if (text.includes('FROM public."user"'))
      return { rows: options.users ?? [{ id: "bob" }] };
    return { rows: [{ binding }] };
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

const baseArgs = [
  "--company",
  "company-b",
  "--iap-subject",
  subject,
  "--capabilities",
  "knowledge.read"
];

describe("parseArguments", () => {
  it("accepts space and equals forms and splits capabilities", () => {
    expect(
      parseArguments([
        "--company=company-b",
        "--user-email",
        "bob@example.com",
        "--iap-subject",
        subject,
        "--capabilities=knowledge.read,knowledge.intake.capture",
        "--allow-remote"
      ])
    ).toEqual({
      company: "company-b",
      userEmail: "bob@example.com",
      userId: undefined,
      iapSubject: subject,
      capabilities: ["knowledge.read", "knowledge.intake.capture"],
      allowRemote: true
    });
  });

  it.each([
    [[], "required"],
    [[...baseArgs], "exactly one of --user-email or --user-id"],
    [[...baseArgs, "--user-email", "a@example.com", "--user-id", "bob"], "exactly one"],
    [[...baseArgs, "--user-id", "bob", "--verbose"], "unknown option"],
    [[...baseArgs, "--user-id"], "requires a value"],
    [[...baseArgs, "--user-id", "bob", "--company", "again"], "twice"]
  ])("rejects %j", (argv, message) => {
    expect(() => parseArguments(argv as string[])).toThrow(message);
  });
});

describe("isLocalDatabaseUrl", () => {
  it.each([
    "postgresql://u:p@127.0.0.1:59930/knowledge_test",
    "postgres://u:p@localhost:59930/knowledge_test",
    "postgresql://u:p@[::1]:59930/knowledge_test"
  ])("accepts %s", (value) => {
    expect(isLocalDatabaseUrl(value)).toBe(true);
  });

  it.each([
    remoteUrl,
    "postgresql://u:p@127.0.0.1:5432/db?host=db.example.com",
    "postgresql://u:p@127.0.0.1:5432/db?hostaddr=10.0.0.5",
    "mysql://u:p@127.0.0.1/db",
    "not a url"
  ])("rejects %s", (value) => {
    expect(isLocalDatabaseUrl(value)).toBe(false);
  });
});

describe("runEnrollment", () => {
  it("binds the given user id locally, printing the subject only on the confirmation line", async () => {
    const h = harness();
    const code = await runEnrollment([...baseArgs, "--user-id", "bob"], h.dependencies);
    expect(code).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, values] = h.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("knowledge.enroll_workforce_identity(");
    expect(values).toEqual([IAP_ISSUER, subject, "company-b", "bob", ["knowledge.read"]]);
    expect(h.out.filter((line) => line.includes(subject))).toHaveLength(1);
    expect(h.out.at(-1)).toContain("Enrolled binding kidn-synthetic: user bob, company company-b, active=true, revocationVersion=1");
    expect(h.out.at(-1)).not.toContain(subject);
    expect(h.err).toEqual([]);
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it("resolves an email hint to the user id and prints the id it binds", async () => {
    const h = harness({ users: [{ id: "bob" }] });
    const code = await runEnrollment([...baseArgs, "--user-email", "bob@example.com"], h.dependencies);
    expect(code).toBe(0);
    const [lookupSql, lookupValues] = h.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(lookupSql).toContain('FROM public."user"');
    expect(lookupValues).toEqual(["bob@example.com"]);
    expect(h.out[0]).toBe("Resolved the email hint to user bob");
    const [, enrollValues] = h.query.mock.calls[1] as unknown as [string, unknown[]];
    expect(enrollValues[3]).toBe("bob");
    expect(h.out.join("\n")).not.toContain("bob@example.com");
  });

  it("fails without writing when the email matches no readable user", async () => {
    const h = harness({ users: [] });
    const code = await runEnrollment([...baseArgs, "--user-email", "nobody@example.com"], h.dependencies);
    expect(code).toBe(1);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.err.join("\n")).toContain("--user-id");
    expect(h.err.join("\n")).not.toContain(subject);
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it("refuses an email-shaped subject before connecting", async () => {
    const h = harness();
    const code = await runEnrollment(
      ["--company", "company-b", "--user-id", "bob", "--iap-subject", "bob@example.com", "--capabilities", "knowledge.read"],
      h.dependencies
    );
    expect(code).toBe(2);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.err.join("\n")).toContain("email is never a subject");
  });

  it("requires the migration database variable", async () => {
    const h = harness({ environment: {} });
    expect(await runEnrollment([...baseArgs, "--user-id", "bob"], h.dependencies)).toBe(2);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.err.join("\n")).toContain(DATABASE_URL_VARIABLE);
  });

  it("refuses a remote database without --allow-remote", async () => {
    const h = harness({ environment: { [DATABASE_URL_VARIABLE]: remoteUrl } });
    expect(await runEnrollment([...baseArgs, "--user-id", "bob"], h.dependencies)).toBe(2);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.err.join("\n")).toContain("--allow-remote");
  });

  it("asks for confirmation on a remote database and writes nothing when declined", async () => {
    const h = harness({ environment: { [DATABASE_URL_VARIABLE]: remoteUrl }, confirm: false });
    expect(await runEnrollment([...baseArgs, "--user-id", "bob", "--allow-remote"], h.dependencies)).toBe(1);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(String(h.confirm.mock.calls[0]?.[0])).toContain(subject);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.out).toEqual([]);
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it("enrolls on a remote database once confirmed", async () => {
    const h = harness({ environment: { [DATABASE_URL_VARIABLE]: remoteUrl }, confirm: true });
    expect(await runEnrollment([...baseArgs, "--user-id", "bob", "--allow-remote"], h.dependencies)).toBe(0);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.out.join("\n")).not.toContain(subject);
  });

  it("reports a database refusal without echoing the subject", async () => {
    const h = harness({ failWith: new Error("subject is already bound to a different user for this issuer") });
    expect(await runEnrollment([...baseArgs, "--user-id", "bob"], h.dependencies)).toBe(1);
    expect(h.err).toEqual(["Enrollment failed: subject is already bound to a different user for this issuer"]);
    expect(h.end).toHaveBeenCalledTimes(1);
  });
});
