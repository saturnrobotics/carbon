import type {
  TrustedCallerConfiguration,
  TrustedTokenVerifier
} from "@carbon/knowledge/identity.server";
import type { Pool } from "pg";

export const localCompanyId = "company-b";
export const localSourceId = "source-b";
export const localItemSourceId = "source-carbon-e2e";
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

// Reserved synthetic IAP subjects, matching the bindings that
// contrib/deploying/knowledge/local-stack-fixture.sql enrolls.
const actorSubjects = {
  alice: "accounts.google.com:100000000000000000001",
  bob: "accounts.google.com:100000000000000000002"
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

const syntheticItems = [
  {
    id: "item-e2e-motor",
    readableId: "EM-100",
    name: "E2E motor",
    revision: "A",
    mpn: "EM-100-A"
  },
  {
    id: "item-e2e-pump",
    readableId: "EP-200",
    name: "E2E pump",
    revision: "B",
    mpn: null
  }
];

/** Synthetic remote for URL intake. The production fetch policy (HTTPS-only,
 * private-address refusal, redirect and byte limits, content-type check) runs
 * unchanged; only DNS and the socket for this one invalid-TLD host are stubbed.
 * `https://<host>/<token>.pdf` serves a one-page PDF whose text is the token. */
export const localUrlIntakeHost = "manuals.e2e.invalid";

function syntheticPdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, (char) => `\\${char}`);
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

export const syntheticUrlIntakeResolve = async (
  hostname: string,
  fallback: (hostname: string) => Promise<readonly string[]>
): Promise<readonly string[]> =>
  hostname === localUrlIntakeHost ? ["203.0.113.10"] : fallback(hostname);

export const syntheticUrlIntakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL
      ? input.toString()
      : input.url
  );
  if (url.hostname !== localUrlIntakeHost) return fetch(input, init);
  const token = url.pathname.match(/^\/([A-Za-z0-9_-]{1,64})\.pdf$/)?.[1];
  if (!token) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(syntheticPdf(`${token} E2E URL manual`)), {
    headers: { "content-type": "application/pdf" }
  });
};

/** Answers only the registered Carbon `resolveItems` operation, from fixed rows. */
export const syntheticItemSourceFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL
      ? input.toString()
      : input.url
  );
  if (
    url.pathname !== "/api/v1/knowledge/resolveItems" ||
    init?.method !== "POST"
  )
    return Response.json({ error: "not_found" }, { status: 404 });
  const body = JSON.parse(String(init?.body ?? "{}")) as { search?: string };
  const search = (body.search ?? "").toLowerCase();
  return Response.json({
    results: syntheticItems.filter((item) =>
      [item.readableId, item.name, item.mpn ?? ""].some((value) =>
        value.toLowerCase().includes(search)
      )
    )
  });
};
