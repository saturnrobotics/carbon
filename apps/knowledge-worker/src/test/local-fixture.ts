import type {
  TrustedCallerConfiguration,
  TrustedTokenVerifier
} from "@carbon/knowledge/identity.server";
import type { Pool } from "pg";

export const localCompanyId = "company-b";
export const localSourceId = "source-b";
export const localCallerId = "knowledge-e2e-loopback";
export const localBucket = "knowledge-e2e";

export const localOperations = [
  "knowledge.query",
  "knowledge.intake.capture",
  "knowledge.intake.review",
  "knowledge.intake.publish",
  "knowledge.document.delete",
  "knowledge.document.download"
] as const;

export const localCapabilities = [
  "knowledge.read",
  "knowledge.intake.capture",
  "knowledge.intake.review",
  "knowledge.intake.publish",
  "knowledge.document.delete",
  "knowledge.document.download"
] as const;

const actorSubjects = {
  alice: "subject-a",
  bob: "subject-b"
} as const;

export function localCallerConfiguration(
  audience: "e2e-query" | "e2e-worker"
): TrustedCallerConfiguration {
  return {
    version: 1,
    receiver: { id: audience, audience },
    callers: [
      {
        callerId: localCallerId,
        serviceAccountSubject: "e2e-service",
        sourceIapAudience: "e2e-iap",
        operations: [...localOperations],
        capabilities: [...localCapabilities],
        requiredAccessLevels: ["e2e-test"]
      }
    ]
  };
}

export const localTokenVerifier: TrustedTokenVerifier = {
  async verifyServiceToken(token, expectedAudience) {
    if (token !== "e2e-service") return {};
    const now = Math.floor(
      (performance.timeOrigin + performance.now()) / 1_000
    );
    return {
      iss: "https://accounts.google.com",
      sub: "e2e-service",
      aud: expectedAudience,
      iat: now - 5,
      exp: now + 300
    };
  },
  async verifyIapToken(token, expectedAudience) {
    const actor =
      token === "e2e-iap:bob"
        ? "bob"
        : token === "e2e-iap:alice"
          ? "alice"
          : undefined;
    if (!actor) return {};
    const now = Math.floor(
      (performance.timeOrigin + performance.now()) / 1_000
    );
    return {
      iss: "https://cloud.google.com/iap",
      sub: actorSubjects[actor],
      aud: expectedAudience,
      iat: now - 5,
      exp: now + 300,
      google: { access_levels: ["e2e-test"] }
    };
  }
};

export async function cleanCapturedIntakes(
  pool: Pool,
  intakeIds: readonly string[]
): Promise<void> {
  if (!intakeIds.length) return;
  await pool.query(
    `DELETE FROM knowledge.audit WHERE "companyId"=$1
       AND ("targetRefs"->>'intakeId'=ANY($2::text[])
         OR "targetRefs"->>'documentId' IN (
           SELECT id FROM knowledge.document WHERE "companyId"=$1
             AND "sourceItemId"=ANY($3::text[])))`,
    [localCompanyId, intakeIds, intakeIds.map((id) => `intake:${id}`)]
  );
  const documents = await pool.query<{ id: string }>(
    `SELECT id FROM knowledge.document WHERE "companyId"=$1
       AND "sourceItemId"=ANY($2::text[])`,
    [localCompanyId, intakeIds.map((id) => `intake:${id}`)]
  );
  const documentIds = documents.rows.map((document) => document.id);
  await pool.query(
    `DELETE FROM knowledge.outbox WHERE "companyId"=$1
       AND ("entityId"=ANY($2::text[]) OR "entityId"=ANY($3::text[]))`,
    [localCompanyId, intakeIds, documentIds]
  );
  if (documentIds.length) {
    await pool.query(
      `UPDATE knowledge.document SET "currentVersionId"=NULL,version=version+1
       WHERE "companyId"=$1 AND id=ANY($2::text[])`,
      [localCompanyId, documentIds]
    );
    await pool.query(
      `DELETE FROM knowledge.chunk WHERE "companyId"=$1
       AND "documentId"=ANY($2::text[])`,
      [localCompanyId, documentIds]
    );
    await pool.query(
      `DELETE FROM knowledge."documentVersion" WHERE "companyId"=$1
       AND "documentId"=ANY($2::text[])`,
      [localCompanyId, documentIds]
    );
    await pool.query(
      `DELETE FROM knowledge."grant" WHERE "companyId"=$1
       AND "documentId"=ANY($2::text[])`,
      [localCompanyId, documentIds]
    );
    await pool.query(
      `DELETE FROM knowledge.document WHERE "companyId"=$1
       AND id=ANY($2::text[])`,
      [localCompanyId, documentIds]
    );
  }
  await pool.query(
    `DELETE FROM knowledge.extraction WHERE "companyId"=$1
       AND "intakeId"=ANY($2::text[])`,
    [localCompanyId, intakeIds]
  );
  await pool.query(
    `DELETE FROM knowledge.intake WHERE "companyId"=$1
       AND id=ANY($2::text[])`,
    [localCompanyId, intakeIds]
  );
}
