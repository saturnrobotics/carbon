/**
 * Operator command: emergency disablement of workforce identity bindings.
 *
 *   # one subject in one company
 *   pnpm --filter @carbon/knowledge identity:revoke -- \
 *     --company <company-id> --iap-subject accounts.google.com:<numeric id>
 *
 *   # every binding of one user (optionally limited to one company)
 *   pnpm --filter @carbon/knowledge identity:revoke -- \
 *     (--user-id <carbon-user-id> | --user-email <email>) [--company <company-id>]
 *
 * Each binding goes through knowledge.unbind_workforce_identity, which sets it
 * inactive and advances its revocationVersion; the next request that presents
 * the subject is refused, and every warmed answer-cache entry keyed on the old
 * version is dead. The command prints the resulting revocationVersion of each
 * binding and nothing else that identifies it. The connection comes from
 * KNOWLEDGE_MIGRATION_DATABASE_URL (the knowledge_migrate schema login);
 * non-local URLs need --allow-remote and an interactive confirmation. Listing a
 * user's bindings requires SET ROLE knowledge_migrate, which the schema login
 * holds through membership.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type EnrollmentQueryable,
  IAP_ISSUER,
  isIapSubject,
  unbindWorkforceIdentity
} from "../src/enrollment.server";
import {
  createConnection,
  DATABASE_URL_VARIABLE,
  describeError,
  type EnrollmentDependencies,
  isLocalDatabaseUrl,
  promptConfirmation,
  resolveUserId
} from "./enroll-identity";

const USAGE = [
  "usage: revoke-identity --company <id> --iap-subject accounts.google.com:<numeric id> [--allow-remote]",
  "       revoke-identity (--user-id <id> | --user-email <email>) [--company <id>] [--allow-remote]"
].join("\n");

export type RevocationArguments = {
  company?: string;
  allowRemote: boolean;
} & (
  | { mode: "subject"; company: string; iapSubject: string }
  | { mode: "user"; userId?: string; userEmail?: string }
);

export type RevocationDependencies = EnrollmentDependencies;

interface BindingReference {
  issuer: string;
  subject: string;
  companyId: string;
}

const VALUE_OPTIONS = new Set([
  "--company",
  "--user-email",
  "--user-id",
  "--iap-subject"
]);

export function parseArguments(argv: readonly string[]): RevocationArguments {
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
  const userId = values.get("--user-id");
  const userEmail = values.get("--user-email");
  const selectors = [iapSubject, userId, userEmail].filter(
    (value) => value !== undefined
  );
  if (selectors.length !== 1)
    throw new Error(
      "exactly one of --iap-subject, --user-id or --user-email is required"
    );
  if (iapSubject !== undefined) {
    if (!company) throw new Error("--company is required with --iap-subject");
    if (!isIapSubject(iapSubject))
      throw new Error(
        "--iap-subject must look like accounts.google.com:<numeric id>; email is never a subject"
      );
    return { mode: "subject", company, iapSubject, allowRemote };
  }
  return { mode: "user", company, userId, userEmail, allowRemote };
}

function isBindingReference(value: unknown): value is BindingReference {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.issuer === "string" &&
    typeof row.subject === "string" &&
    typeof row.companyId === "string"
  );
}

/** Every binding of one user; needs the migrate role's own SELECT policy. */
async function listUserBindings(
  db: EnrollmentQueryable,
  userId: string,
  companyId: string | undefined
): Promise<BindingReference[]> {
  try {
    await db.query("SET ROLE knowledge_migrate");
  } catch {
    throw new Error(
      "listing a user's bindings needs a connection that can SET ROLE knowledge_migrate; pass --iap-subject with --company instead"
    );
  }
  try {
    const result = await db.query(
      'SELECT issuer, subject, "companyId" FROM knowledge."identityBinding" WHERE "canonicalUserId"=$1::text AND ($2::text IS NULL OR "companyId"=$2::text) ORDER BY "companyId", issuer, subject',
      [userId, companyId ?? null]
    );
    return result.rows.map((row) => {
      if (!isBindingReference(row))
        throw new Error("binding lookup returned an unexpected row");
      return row;
    });
  } finally {
    await db.query("RESET ROLE");
  }
}

export async function runRevocation(
  argv: readonly string[],
  dependencies: RevocationDependencies
): Promise<number> {
  let parsed: RevocationArguments;
  try {
    parsed = parseArguments(argv);
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
      "Refusing a non-local database URL; re-run with --allow-remote to revoke against a remote database"
    );
    return 2;
  }

  const db = await dependencies.connect(databaseUrl);
  try {
    let targets: BindingReference[];
    if (parsed.mode === "subject") {
      targets = [
        {
          issuer: IAP_ISSUER,
          subject: parsed.iapSubject,
          companyId: parsed.company
        }
      ];
    } else {
      const userId =
        parsed.userId ?? (await resolveUserId(db, parsed.userEmail as string));
      targets = await listUserBindings(db, userId, parsed.company);
      if (targets.length === 0) {
        dependencies.stderr("No bindings exist for that user; nothing to revoke");
        return 1;
      }
    }

    const summary =
      parsed.mode === "subject"
        ? `Revoke the binding for one subject in company ${parsed.company}`
        : `Revoke ${targets.length} binding(s) of one user${parsed.company ? ` in company ${parsed.company}` : ""}`;
    if (remote) {
      if (!(await dependencies.confirm(`${summary}?`))) {
        dependencies.stderr("Aborted; nothing was written");
        return 1;
      }
    } else {
      dependencies.stdout(summary);
    }

    // Sequential on purpose: an emergency command must report exactly how far
    // it got if a later binding fails.
    for (const target of targets) {
      const binding = await unbindWorkforceIdentity(db, target);
      dependencies.stdout(`revocationVersion=${binding.revocationVersion}`);
    }
    return 0;
  } catch (error) {
    dependencies.stderr(`Revocation failed: ${describeError(error)}`);
    return 1;
  } finally {
    await db.end();
  }
}

async function main(): Promise<number> {
  return runRevocation(process.argv.slice(2), {
    environment: process.env,
    connect: createConnection,
    confirm: (question) => promptConfirmation(question, "revoke"),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`)
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  process.exitCode = await main();
}
