/**
 * Typed wrappers over the two enrollment functions owned by
 * portal_enrollment_owner. Call them on the dedicated portal_migrate
 * connection (the schema login); runtime roles cannot execute them.
 *
 * The database is authoritative for every rule below; the client-side checks
 * only refuse obviously wrong input before a round trip.
 */

/** Google IAP issuer, the only workforce issuer manual-v1 enrolls. */
export const IAP_ISSUER = "https://cloud.google.com/iap";

/** An IAP subject is `accounts.google.com:<numeric id>`; email is never a subject. */
export const IAP_SUBJECT_PATTERN = /^accounts\.google\.com:\d+$/;

const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const MAX_IDENTIFIER_LENGTH = 2048;

/** The subset of a pg Pool or PoolClient the wrappers use. */
export interface EnrollmentQueryable {
  query(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: unknown[] }>;
}

export interface WorkforceIdentityBindingRecord {
  id: string;
  companyId: string;
  issuer: string;
  subject: string;
  canonicalUserId: string;
  active: boolean;
  revocationVersion: number;
  version: number;
  capabilities: string[];
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface EnrollWorkforceIdentityInput {
  issuer?: string;
  subject: string;
  companyId: string;
  userId: string;
  capabilities: readonly string[];
}

export interface UnbindWorkforceIdentityInput {
  issuer?: string;
  subject: string;
  companyId: string;
}

/** Input refused before any database call. Messages never echo the subject. */
export class EnrollmentInputError extends Error {
  override readonly name = "EnrollmentInputError";
}

export function isIapSubject(subject: string): boolean {
  return (
    subject.length <= MAX_IDENTIFIER_LENGTH &&
    !subject.includes("@") &&
    IAP_SUBJECT_PATTERN.test(subject)
  );
}

function requireIdentifier(value: string | undefined, label: string): string {
  if (!value || value.length > MAX_IDENTIFIER_LENGTH)
    throw new EnrollmentInputError(`${label} is required`);
  return value;
}

function requireIapSubject(subject: string | undefined): string {
  if (!subject || !isIapSubject(subject))
    throw new EnrollmentInputError(
      "subject must be an IAP subject of the form accounts.google.com:<numeric id>; email is never a subject"
    );
  return subject;
}

export function normalizeCapabilities(
  capabilities: readonly string[]
): string[] {
  const normalized = [
    ...new Set(capabilities.map((value) => value.trim()).filter(Boolean))
  ].sort();
  if (normalized.length === 0)
    throw new EnrollmentInputError("at least one capability is required");
  if (
    normalized.some(
      (value) => value.length > 128 || !CAPABILITY_PATTERN.test(value)
    )
  )
    throw new EnrollmentInputError(
      "capabilities must be dotted lowercase names such as portal.read"
    );
  return normalized;
}

function isBindingRecord(
  value: unknown
): value is WorkforceIdentityBindingRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.companyId === "string" &&
    typeof record.issuer === "string" &&
    typeof record.subject === "string" &&
    typeof record.canonicalUserId === "string" &&
    typeof record.active === "boolean" &&
    typeof record.revocationVersion === "number" &&
    typeof record.version === "number" &&
    Array.isArray(record.capabilities) &&
    record.capabilities.every((capability) => typeof capability === "string")
  );
}

function bindingFromRow(row: unknown): WorkforceIdentityBindingRecord {
  const binding =
    row && typeof row === "object" && "binding" in row
      ? (row as { binding: unknown }).binding
      : undefined;
  if (!isBindingRecord(binding))
    throw new Error("enrollment function returned an unexpected row");
  return binding;
}

/**
 * Bind an IAP subject to an existing active Carbon user with current company
 * membership. Idempotent for identical input; re-running with different
 * capabilities updates the ceiling; a subject bound to another user is refused.
 */
export async function enrollWorkforceIdentity(
  db: EnrollmentQueryable,
  input: EnrollWorkforceIdentityInput
): Promise<WorkforceIdentityBindingRecord> {
  const issuer = requireIdentifier(input.issuer ?? IAP_ISSUER, "issuer");
  const subject = requireIapSubject(input.subject);
  const companyId = requireIdentifier(input.companyId, "company id");
  const userId = requireIdentifier(input.userId, "user id");
  const capabilities = normalizeCapabilities(input.capabilities);
  const result = await db.query(
    "SELECT portal.enroll_workforce_identity($1::text,$2::text,$3::text,$4::text,$5::text[]) AS binding",
    [issuer, subject, companyId, userId, capabilities]
  );
  return bindingFromRow(result.rows[0]);
}

/** Deactivate a binding and advance its revocationVersion. */
export async function unbindWorkforceIdentity(
  db: EnrollmentQueryable,
  input: UnbindWorkforceIdentityInput
): Promise<WorkforceIdentityBindingRecord> {
  const issuer = requireIdentifier(input.issuer ?? IAP_ISSUER, "issuer");
  const subject = requireIdentifier(input.subject, "subject");
  const companyId = requireIdentifier(input.companyId, "company id");
  const result = await db.query(
    "SELECT portal.unbind_workforce_identity($1::text,$2::text,$3::text) AS binding",
    [issuer, subject, companyId]
  );
  return bindingFromRow(result.rows[0]);
}
