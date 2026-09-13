/**
 * Fixture-only SQL against the labelled disposable stack database, through the
 * same `docker exec` path the global setup already trusts. Statements here are
 * fixed synthetic literals: grant revocation and restoration for the browser
 * authorization proof. Never point this at a developer or production database.
 */
import { execFileSync } from "node:child_process";

const container =
  process.env.KNOWLEDGE_E2E_DATABASE_CONTAINER ?? "knowledge-schema-test";

function assertLabelledDisposable(): void {
  const inspection = JSON.parse(
    execFileSync("docker", ["inspect", container], { encoding: "utf8" })
  ) as Array<{ Config?: { Labels?: Record<string, string> } }>;
  if (inspection[0]?.Config?.Labels?.["knowledge.disposable"] !== "true")
    throw new Error(
      "Browser fixture SQL requires the labelled disposable container"
    );
}

export function fixtureSql(statement: string): string[] {
  assertLabelledDisposable();
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGPASSWORD=synthetic-test-only",
      container,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      "knowledge_test",
      "-At"
    ],
    { input: statement, encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean);
}

const libraryGrant = "e2e-bob-admin";

/** Revoke Bob's library grant: every manual in the upload source loses its read path. */
export function revokeLibraryGrant(): void {
  fixtureSql(
    `UPDATE knowledge."grant" SET "revokedAt"=now(),version=version+1 WHERE id='${libraryGrant}' AND "companyId"='company-b' AND "revokedAt" IS NULL`
  );
}

export function restoreLibraryGrant(): void {
  fixtureSql(
    `UPDATE knowledge."grant" SET "revokedAt"=NULL,version=version+1 WHERE id='${libraryGrant}' AND "companyId"='company-b'`
  );
}
