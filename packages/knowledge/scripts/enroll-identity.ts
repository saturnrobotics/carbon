/**
 * Operator command: bind one IAP subject to an existing active Carbon user.
 *
 *   pnpm --filter @carbon/knowledge identity:enroll -- \
 *     --company <company-id> --user-email <email> \
 *     --iap-subject accounts.google.com:<numeric id> \
 *     --capabilities knowledge.read,knowledge.intake.capture
 *
 * The email is only a lookup hint: the command resolves it to a user id, prints
 * that id, and binds the id. Pass --user-id instead when the connection cannot
 * read public."user". The connection comes from KNOWLEDGE_MIGRATION_DATABASE_URL
 * (the knowledge_migrate schema login); non-local URLs need --allow-remote and
 * an interactive confirmation. The subject is printed once, on the confirmation
 * line, and nowhere else.
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  type EnrollmentQueryable,
  enrollWorkforceIdentity,
  IAP_ISSUER,
  isIapSubject,
  normalizeCapabilities
} from "../src/enrollment.server";

export const DATABASE_URL_VARIABLE = "KNOWLEDGE_MIGRATION_DATABASE_URL";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const USAGE = [
  "usage: enroll-identity --company <id> (--user-email <email> | --user-id <id>)",
  "         --iap-subject accounts.google.com:<numeric id>",
  "         --capabilities <name>[,<name>...] [--allow-remote]"
].join("\n");

export interface EnrollmentArguments {
  company: string;
  userEmail?: string;
  userId?: string;
  iapSubject: string;
  capabilities: string[];
  allowRemote: boolean;
}

export interface EnrollmentConnection extends EnrollmentQueryable {
  end(): Promise<void>;
}

export interface EnrollmentDependencies {
  environment: Record<string, string | undefined>;
  connect(databaseUrl: string): Promise<EnrollmentConnection>;
  confirm(question: string): Promise<boolean>;
  stdout(line: string): void;
  stderr(line: string): void;
}

const VALUE_OPTIONS = new Set([
  "--company",
  "--user-email",
  "--user-id",
  "--iap-subject",
  "--capabilities"
]);

export function parseArguments(argv: readonly string[]): EnrollmentArguments {
  const values = new Map<string, string>();
  let allowRemote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    // pnpm forwards a literal "--" separator on some versions.
    if (argument === "--") continue;
    if (argument === "--allow-remote") {
      allowRemote = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (!VALUE_OPTIONS.has(name)) throw new Error(`unknown option ${argument}`);
    const value =
      separator === -1 ? argv[(index += 1)] : argument.slice(separator + 1);
    if (value === undefined || value === "" || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was given twice`);
    values.set(name, value);
  }
  const company = values.get("--company");
  const iapSubject = values.get("--iap-subject");
  const capabilities = values.get("--capabilities");
  const userEmail = values.get("--user-email");
  const userId = values.get("--user-id");
  if (!company || !iapSubject || !capabilities)
    throw new Error("--company, --iap-subject and --capabilities are required");
  if ((userEmail === undefined) === (userId === undefined))
    throw new Error("exactly one of --user-email or --user-id is required");
  return {
    company,
    userEmail,
    userId,
    iapSubject,
    capabilities: capabilities.split(","),
    allowRemote
  };
}

export function isLocalDatabaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    LOCAL_HOSTS.has(url.hostname) &&
    !url.searchParams.has("host") &&
    !url.searchParams.has("hostaddr")
  );
}

async function resolveUserId(
  db: EnrollmentQueryable,
  email: string
): Promise<string> {
  const result = await db.query(
    'SELECT id FROM public."user" WHERE lower(email)=lower($1::text) ORDER BY id',
    [email]
  );
  if (result.rows.length === 0)
    throw new Error(
      "no user matched that email through this connection; pass --user-id with the Carbon user id"
    );
  if (result.rows.length > 1)
    throw new Error(
      "more than one user matched that email; pass --user-id with the Carbon user id"
    );
  const row = result.rows[0];
  const id =
    row && typeof row === "object" && "id" in row
      ? (row as { id: unknown }).id
      : undefined;
  if (typeof id !== "string" || !id)
    throw new Error("user lookup returned an unexpected row");
  return id;
}

function describeError(error: unknown): string {
  // Only the primary message: PostgreSQL DETAIL lines can echo key values.
  return error instanceof Error ? error.message : "unknown failure";
}

export async function runEnrollment(
  argv: readonly string[],
  dependencies: EnrollmentDependencies
): Promise<number> {
  let parsed: EnrollmentArguments;
  let capabilities: string[];
  try {
    parsed = parseArguments(argv);
    if (!isIapSubject(parsed.iapSubject))
      throw new Error(
        "--iap-subject must look like accounts.google.com:<numeric id>; email is never a subject"
      );
    capabilities = normalizeCapabilities(parsed.capabilities);
  } catch (error) {
    dependencies.stderr(`${describeError(error)}\n${USAGE}`);
    return 2;
  }

  const databaseUrl = dependencies.environment[DATABASE_URL_VARIABLE];
  if (!databaseUrl) {
    dependencies.stderr(
      `${DATABASE_URL_VARIABLE} is required: the knowledge_migrate schema login`
    );
    return 2;
  }
  const remote = !isLocalDatabaseUrl(databaseUrl);
  if (remote && !parsed.allowRemote) {
    dependencies.stderr(
      "Refusing a non-local database URL; re-run with --allow-remote to enroll against a remote database"
    );
    return 2;
  }

  const db = await dependencies.connect(databaseUrl);
  try {
    const userId =
      parsed.userId ?? (await resolveUserId(db, parsed.userEmail as string));
    if (parsed.userEmail !== undefined)
      dependencies.stdout(`Resolved the email hint to user ${userId}`);
    const confirmation = `Bind IAP subject ${parsed.iapSubject} to user ${userId} in company ${parsed.company} with capabilities ${capabilities.join(", ")}`;
    if (remote) {
      if (!(await dependencies.confirm(`${confirmation}?`))) {
        dependencies.stderr("Aborted; nothing was written");
        return 1;
      }
    } else {
      dependencies.stdout(confirmation);
    }
    const binding = await enrollWorkforceIdentity(db, {
      issuer: IAP_ISSUER,
      subject: parsed.iapSubject,
      companyId: parsed.company,
      userId,
      capabilities
    });
    dependencies.stdout(
      `Enrolled binding ${binding.id}: user ${binding.canonicalUserId}, company ${binding.companyId}, active=${binding.active}, revocationVersion=${binding.revocationVersion}, version=${binding.version}, capabilities=${binding.capabilities.join(",")}`
    );
    return 0;
  } catch (error) {
    dependencies.stderr(`Enrollment failed: ${describeError(error)}`);
    return 1;
  } finally {
    await db.end();
  }
}

async function promptConfirmation(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr
  });
  try {
    const answer = await prompt.question(`${question} Type "enroll" to continue: `);
    return answer.trim() === "enroll";
  } finally {
    prompt.close();
  }
}

async function main(): Promise<number> {
  return runEnrollment(process.argv.slice(2), {
    environment: process.env,
    connect: async (databaseUrl) => {
      const pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5_000
      });
      return {
        query: (text, values) => pool.query(text, values ? [...values] : undefined),
        end: () => pool.end()
      };
    },
    confirm: promptConfirmation,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`)
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  process.exitCode = await main();
}
