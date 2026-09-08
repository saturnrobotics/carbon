/**
 * Loopback-only E2E gateway. It invokes the real worker and query handlers over
 * the labelled disposable PostgreSQL fixture. Authentication and parser output
 * are synthetic test seams; no Google credential or production endpoint is used.
 */
import { createServer, type Server } from "node:http";
import type { VerifiedWorkforceIdentity } from "@carbon/knowledge/identity.server";
import { postgresIdentityStore } from "@carbon/knowledge/identity-store.server";
import { Pool } from "pg";
import { createReadHandler } from "../../../knowledge-query/src/query.server";
import { createWorkerHandler, type WorkerDependencies } from "../server";

const companyId = "company-b";
const sourceId = "source-b";
const callerId = "knowledge-e2e-loopback";
const sourceIdentity = { issuer: "https://cloud.google.com/iap" };

const callerConfiguration = {
  version: 1 as const,
  receiver: { id: "e2e-query", audience: "e2e-query" },
  callers: [
    {
      callerId,
      serviceAccountSubject: "e2e-service",
      sourceIapAudience: "e2e-iap",
      operations: ["knowledge.query"],
      capabilities: ["knowledge.read"],
      requiredAccessLevels: ["e2e-test"]
    }
  ]
};

type Actor = "bob" | "alice";
const actorSubjects: Record<Actor, string> = {
  bob: "subject-b",
  alice: "subject-a"
};

function actorFromEvidence(request: Request): Actor {
  const value = request.headers.get("x-portal-user-evidence");
  if (value === "e2e-iap:bob" || value === "e2e-iap:alice")
    return value.slice("e2e-iap:".length) as Actor;
  throw new Error("unauthorized");
}

function principal(actor: Actor): VerifiedWorkforceIdentity {
  return {
    principal: {
      kind: "human",
      actorId: actor,
      companyId,
      callerId,
      sourceIdentity: { ...sourceIdentity, subject: actorSubjects[actor] },
      policyVersion: "e2e-test",
      capabilities: [
        "knowledge.read",
        "knowledge.intake.capture",
        "knowledge.intake.review",
        "knowledge.intake.publish",
        "knowledge.document.delete",
        "knowledge.document.download"
      ]
    },
    companyGroupId: companyId,
    allowedOperations: [
      "knowledge.query",
      "knowledge.intake.capture",
      "knowledge.intake.review",
      "knowledge.intake.publish",
      "knowledge.document.delete",
      "knowledge.document.download"
    ],
    accessLevels: ["e2e-test"]
  };
}

class MemoryStorage {
  private readonly values = new Map<
    string,
    { bytes: Buffer; generation: string }
  >();
  bucket(bucketName: string) {
    return {
      file: (objectKey: string, options?: { generation?: string }) => {
        const key = `${bucketName}/${objectKey}`;
        return {
          save: async (
            value: Buffer,
            options?: { preconditionOpts?: { ifGenerationMatch?: number } }
          ) => {
            if (
              options?.preconditionOpts?.ifGenerationMatch === 0 &&
              this.values.has(key)
            ) {
              throw Object.assign(new Error("precondition failed"), {
                code: 412
              });
            }
            this.values.set(key, {
              bytes: Buffer.from(value),
              generation: "1"
            });
          },
          getMetadata: async () => {
            const stored = this.values.get(key);
            if (!stored) throw new Error("object missing");
            return [
              {
                generation: options?.generation ?? stored.generation,
                size: String(stored.bytes.length)
              }
            ];
          },
          download: async () => {
            const stored = this.values.get(key);
            if (!stored) throw new Error("object missing");
            return [Buffer.from(stored.bytes)];
          }
        };
      }
    };
  }
}

function rolePool(
  connectionString: string,
  role: "knowledge_read" | "knowledge_review"
) {
  return new Pool({
    connectionString,
    options: `-c role=${role}`,
    max: 4,
    connectionTimeoutMillis: 1_000,
    statement_timeout: 2_000
  });
}

async function bridge(
  server: Server,
  handler: (request: Request) => Promise<Response>
) {
  server.on("request", async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    }
    const body = Buffer.concat(chunks);
    try {
      const response = await handler(
        new Request(
          new URL(
            incoming.url ?? "/",
            `http://${incoming.headers.host ?? "127.0.0.1"}`
          ),
          { method: incoming.method, headers, ...(body.length ? { body } : {}) }
        )
      );
      response.headers.forEach((value, key) => {
        outgoing.setHeader(key, value);
      });
      outgoing
        .writeHead(response.status)
        .end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing
        .writeHead(503)
        .end(JSON.stringify({ error: "e2e_gateway_unavailable" }));
    }
  });
}

export type E2eGateway = { close(): Promise<void> };

export async function startE2eGateway(
  databaseUrl: string
): Promise<E2eGateway> {
  // The guarded URL names the non-login test migrator. The actual handlers run
  // under their restricted database roles, assumed from the fixture administrator.
  const administratorUrl = new URL(databaseUrl);
  administratorUrl.username = "supabase_admin";
  administratorUrl.password = "synthetic-test-only";
  const connectionString = administratorUrl.toString();
  const readPool = rolePool(connectionString, "knowledge_read");
  const reviewPool = rolePool(connectionString, "knowledge_review");
  const fixturePool = new Pool({ connectionString, max: 2 });
  const capturedIntakes = new Set<string>();
  let bobRevoked = false;
  const storage = new MemoryStorage();

  // Prefix-scoped grants are the only persistent fixture rows; teardown removes
  // exactly these rows and the documents/intakes created during the browser run.
  await fixturePool.query(
    `DELETE FROM knowledge."grant" WHERE "companyId"=$1
       AND id IN ('e2e-bob-read','e2e-bob-publish')`,
    [companyId]
  );
  // The fixture's ordinary bindings use a non-IAP issuer. Add a narrowly
  // scoped binding for this gateway's synthetic but verifier-shaped IAP claim,
  // so the actual PostgreSQL identity-resolution function runs in the flow.
  await fixturePool.query(
    `DELETE FROM knowledge."identityBinding" WHERE "companyId"=$1 AND id='e2e-bob-iap-binding'`,
    [companyId]
  );
  await fixturePool.query(
    `INSERT INTO knowledge."identityBinding"
       (id,"companyId","createdBy",issuer,subject,"canonicalUserId",active,"revocationVersion",capabilities)
     VALUES ('e2e-bob-iap-binding',$1,'bob','https://cloud.google.com/iap','subject-b','bob',true,1,ARRAY['knowledge.read']::text[])`,
    [companyId]
  );
  await fixturePool.query(
    `
    INSERT INTO knowledge."grant" (id,"companyId","createdBy","sourceId","subjectKind","subjectId",capability,origin,"policyVersion")
    VALUES
      ('e2e-bob-read',$1,'bob',$2,'user','bob','read','local',1),
      ('e2e-bob-publish',$1,'bob',$2,'user','bob','publish','local',1)
  `,
    [companyId, sourceId]
  );

  const verifyActiveSyntheticHuman = async (request: Request) => {
    const actor = actorFromEvidence(request);
    const result = await fixturePool.query<{ active: boolean }>(
      `SELECT active FROM public."user" WHERE id=$1`,
      [actor]
    );
    if (result.rows[0]?.active !== true) throw new Error("unauthorized");
    return principal(actor);
  };

  const dependencies: WorkerDependencies = {
    reviewPool,
    readPool,
    ingestPool: reviewPool,
    bucket: "e2e-memory-bucket",
    storage: storage as never,
    // Test identity substitutes Google verification only. Current user activity
    // still comes from the fixture, mirroring revocation at a receiving service.
    verifyHuman: async (request) => verifyActiveSyntheticHuman(request),
    machineConfiguration: { audience: "e2e-machine", callers: [] },
    automationUserId: "bob",
    manualSource: { sourceId, displayName: "Operations manuals" },
    connectorAccessToken: async () => null,
    userDriveAccessToken: async () => null
  };
  const worker = createWorkerHandler(dependencies);
  const workerServer = createServer();
  await bridge(workerServer, async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/__e2e/revoke/bob") {
      await fixturePool.query(
        `UPDATE public."user" SET active=false WHERE id='bob'`
      );
      bobRevoked = true;
      return Response.json({ state: "revoked" });
    }
    if (request.method === "POST" && path === "/__e2e/restore/bob") {
      await fixturePool.query(
        `UPDATE public."user" SET active=true WHERE id='bob'`
      );
      bobRevoked = false;
      return Response.json({ state: "active" });
    }
    const response = await worker(request);
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/v1/intake" &&
      response.status === 202
    ) {
      const body = (await response.clone().json()) as {
        id: string;
        generation: string;
      };
      capturedIntakes.add(body.id);
      await fixturePool.query(
        `UPDATE knowledge.intake SET state='needs-review', extraction=$3::jsonb, version=version+1
         WHERE id=$1 AND "companyId"=$2`,
        [
          body.id,
          companyId,
          JSON.stringify({
            title: "E2E motor manual",
            manufacturer: "E2E Motors",
            partNumber: "EM-100",
            revision: "A",
            machine: "Test bench"
          })
        ]
      );
      await fixturePool.query(
        `INSERT INTO knowledge.extraction ("companyId","createdBy","intakeId",generation,"providerProfile","sourceVersions",output,status)
         VALUES ($1,'bob',$2,$3,'e2e-parser-fixture','{}',$4::jsonb,'complete')
         ON CONFLICT ("companyId","intakeId",generation) DO UPDATE SET output=EXCLUDED.output,status='complete'`,
        [
          companyId,
          body.id,
          Number(body.generation),
          JSON.stringify({
            fields: {},
            evidence: {
              manual: [
                {
                  page: 1,
                  text: "E2E motor manual EM-100 revision A Test bench"
                }
              ]
            }
          })
        ]
      );
    }
    return response;
  });
  await new Promise<void>((resolve) =>
    workerServer.listen(4301, "127.0.0.1", resolve)
  );

  const tokenVerifier = {
    verifyServiceToken: async () => ({
      iss: "https://accounts.google.com",
      sub: "e2e-service",
      aud: "e2e-query",
      iat: 900,
      exp: 1200
    }),
    verifyIapToken: async (token: string) => {
      const actor =
        token === "e2e-iap:bob"
          ? "bob"
          : token === "e2e-iap:alice"
            ? "alice"
            : undefined;
      if (!actor) return {};
      return {
        iss: "https://cloud.google.com/iap",
        sub: actorSubjects[actor],
        aud: "e2e-iap",
        iat: 900,
        exp: 1200,
        google: { access_levels: ["e2e-test"] }
      };
    }
  };
  const query = createReadHandler({
    pool: readPool,
    configuration: callerConfiguration,
    tokenVerifier,
    nowEpochSeconds: 1000,
    identityStore: postgresIdentityStore(readPool),
    cacheStore: {
      get: async () => undefined,
      set: async () => {
        // This browser harness intentionally disables caching.
      }
    },
    origin: "https://localhost:4200",
    businessTimezone: "UTC",
    manualSourceId: sourceId
  });
  const queryServer = createServer();
  await bridge(queryServer, query);
  await new Promise<void>((resolve) =>
    queryServer.listen(4302, "127.0.0.1", resolve)
  );

  return {
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => workerServer.close(() => resolve())),
        new Promise<void>((resolve) => queryServer.close(() => resolve()))
      ]);
      if (capturedIntakes.size) {
        const ids = [...capturedIntakes];
        await fixturePool.query(
          `DELETE FROM knowledge.audit WHERE "companyId"=$1 AND "requestId" LIKE 'intake-%' AND "targetRefs"::text LIKE '%e2e%'`,
          [companyId]
        );
        await fixturePool.query(
          `DELETE FROM knowledge.outbox WHERE "companyId"=$1 AND "entityId"=ANY($2::text[])`,
          [companyId, ids]
        );
        const documents = await fixturePool.query<{ id: string }>(
          `SELECT id FROM knowledge.document WHERE "companyId"=$1 AND "sourceItemId"=ANY($2::text[])`,
          [companyId, ids.map((id) => `intake:${id}`)]
        );
        const documentIds = documents.rows.map((document) => document.id);
        if (documentIds.length) {
          await fixturePool.query(
            `UPDATE knowledge.document SET "currentVersionId"=NULL,version=version+1 WHERE "companyId"=$1 AND id=ANY($2::text[])`,
            [companyId, documentIds]
          );
          await fixturePool.query(
            `DELETE FROM knowledge.chunk WHERE "companyId"=$1 AND "documentId"=ANY($2::text[])`,
            [companyId, documentIds]
          );
          await fixturePool.query(
            `DELETE FROM knowledge."documentVersion" WHERE "companyId"=$1 AND "documentId"=ANY($2::text[])`,
            [companyId, documentIds]
          );
          await fixturePool.query(
            `DELETE FROM knowledge."grant" WHERE "companyId"=$1 AND "documentId"=ANY($2::text[])`,
            [companyId, documentIds]
          );
          await fixturePool.query(
            `DELETE FROM knowledge.document WHERE "companyId"=$1 AND id=ANY($2::text[])`,
            [companyId, documentIds]
          );
        }
        await fixturePool.query(
          `DELETE FROM knowledge.extraction WHERE "companyId"=$1 AND "intakeId"=ANY($2::text[])`,
          [companyId, ids]
        );
        await fixturePool.query(
          `DELETE FROM knowledge.intake WHERE "companyId"=$1 AND id=ANY($2::text[])`,
          [companyId, ids]
        );
      }
      await fixturePool.query(
        `DELETE FROM knowledge."grant" WHERE "companyId"=$1 AND id IN ('e2e-bob-read','e2e-bob-publish')`,
        [companyId]
      );
      if (bobRevoked)
        await fixturePool.query(
          `UPDATE public."user" SET active=true WHERE id='bob'`
        );
      await Promise.all([readPool.end(), reviewPool.end(), fixturePool.end()]);
    }
  };
}
