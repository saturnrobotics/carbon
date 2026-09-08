import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getAuthorizedDocumentVersion,
  tombstoneManualDocument
} from "../documents.server";
import { confirmOutboxApplied } from "../indexing/outbox.server";
import { lexicalSearch } from "../retrieval/lexical.server";
import { getDisposableLocalDatabaseUrl } from "../test/database";
import {
  createExtraction,
  persistExtractionGeneration
} from "./extraction.server";
import {
  captureIdentity,
  manualReviewDecisions,
  persistCapturedIntake,
  saveReviewDecisions
} from "./intake.server";
import { getIntakeForReview, publishReviewedIntake } from "./publish.server";

const companyId = "company-a";
const actorId = "alice";
const sourceId = "manual-workflow-source";
const principal = { companyId, actorId, callerId: "manual-workflow-test" };
const databaseUrl = getDisposableLocalDatabaseUrl();

async function rolePool(
  role: "knowledge_review" | "knowledge_ingest" | "knowledge_read",
  connectionString: string
) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${role}`);
  } finally {
    client.release();
  }
  return pool;
}

describe("real PostgreSQL manual workflow", () => {
  let reviewPool: pg.Pool;
  let ingestPool: pg.Pool;
  let readPool: pg.Pool;
  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl);
    adminUrl.username = "supabase_admin";
    adminUrl.password = "synthetic-test-only";
    const admin = new pg.Pool({
      connectionString: adminUrl.toString(),
      max: 1
    });
    await admin.query(
      `INSERT INTO knowledge.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
       VALUES ($1,$2,$3,'upload','manual-workflow','Synthetic manual workflow',$3,'internal',$4::jsonb)
       ON CONFLICT (id,"companyId") DO UPDATE SET "providerPolicy"=EXCLUDED."providerPolicy",version=knowledge.source.version+1`,
      [
        sourceId,
        companyId,
        actorId,
        JSON.stringify({
          machineCallers: ["manual-index"],
          ingestDatabaseRoles: ["supabase_admin"]
        })
      ]
    );
    await admin.query(
      `DELETE FROM knowledge."grant" WHERE "companyId"=$1 AND "sourceId"=$2 AND id='manual-workflow-admin'`,
      [companyId, sourceId]
    );
    await admin.query(
      `INSERT INTO knowledge."grant"(id,"companyId","createdBy","sourceId","subjectKind","subjectId",capability,origin,"policyVersion")
       VALUES ('manual-workflow-read',$2,$3,$1,'user',$3,'read','local',1),
         ('manual-workflow-publish',$2,$3,$1,'user',$3,'publish','local',1)
       ON CONFLICT DO NOTHING`,
      [sourceId, companyId, actorId]
    );
    await admin.query(
      `UPDATE knowledge.document SET kind='manual',version=version+1 WHERE "companyId"=$1 AND "sourceId"=$2 AND kind<>'manual'`,
      [companyId, sourceId]
    );
    await admin.end();
    reviewPool = await rolePool("knowledge_review", adminUrl.toString());
    ingestPool = await rolePool("knowledge_ingest", adminUrl.toString());
    readPool = await rolePool("knowledge_read", adminUrl.toString());
  });
  afterAll(async () => {
    await Promise.all([reviewPool?.end(), ingestPool?.end(), readPool?.end()]);
    const adminUrl = new URL(databaseUrl);
    adminUrl.username = "supabase_admin";
    adminUrl.password = "synthetic-test-only";
    const cleanup = new pg.Pool({
      connectionString: adminUrl.toString(),
      max: 1
    });
    try {
      // This source belongs exclusively to this synthetic fixture. A failed
      // assertion must not leave published documents in another suite's corpus.
      await cleanup.query(
        `UPDATE knowledge.document SET status='withdrawn',"deletedAt"=now(),version=version+1 WHERE "companyId"=$1 AND "sourceId"=$2 AND "deletedAt" IS NULL`,
        [companyId, sourceId]
      );
    } finally {
      await cleanup.end();
    }
  });

  it("publishes searchable immutable metadata and tombstones without resurrection", async () => {
    const runId = crypto.randomUUID().replaceAll("-", "");
    const captured = await persistCapturedIntake(
      reviewPool,
      principal,
      captureIdentity({
        sourceId,
        ownerId: actorId,
        acl: "internal",
        input: {
          kind: "object",
          objectKey: `synthetic/${runId}.pdf`,
          generation: "1",
          sha256: runId.repeat(2),
          mimeType: "application/pdf",
          bytes: 100
        }
      })
    );
    const extraction = createExtraction({
      fields: { title: "Synthetic motor manual" },
      evidence: {
        body: [{ page: 1, text: "Synthetic motor maintenance procedure" }]
      }
    });
    await persistExtractionGeneration(
      ingestPool,
      { companyId, callerId: "manual-index", sourceId },
      {
        intakeId: captured.id,
        generation: captured.generation,
        expectedGeneration: captured.generation,
        createdBy: "automation",
        providerProfile: "parser-v1",
        sourceVersions: { objectGeneration: "1" },
        extraction
      }
    );
    const extracted = (await getIntakeForReview(
      reviewPool,
      principal,
      captured.id
    )) as { version: string; generation: string };
    const review = manualReviewDecisions({
      title: "Synthetic motor manual",
      manufacturer: "Example Manufacturing",
      partNumber: "MTR-100",
      revision: "A",
      machine: "Assembly cell"
    });
    await saveReviewDecisions(reviewPool, principal, {
      intakeId: captured.id,
      expectedGeneration: extracted.generation,
      expectedVersion: extracted.version,
      expectedSourceId: sourceId,
      decisions: review.decisions,
      unresolved: []
    });
    const reviewed = (await getIntakeForReview(
      reviewPool,
      principal,
      captured.id
    )) as { version: string; generation: string; state: string };
    expect(reviewed.state).toBe("ready");
    const requestId = `publish-${captured.id}`;
    const published = await publishReviewedIntake(reviewPool, principal, {
      intakeId: captured.id,
      expectedGeneration: reviewed.generation,
      expectedVersion: reviewed.version,
      expectedSourceId: sourceId,
      requestId
    });
    await expect(
      publishReviewedIntake(reviewPool, principal, {
        intakeId: captured.id,
        expectedGeneration: reviewed.generation,
        expectedVersion: reviewed.version,
        expectedSourceId: sourceId,
        requestId
      })
    ).resolves.toEqual(published);
    await expect(
      publishReviewedIntake(reviewPool, principal, {
        intakeId: captured.id,
        expectedGeneration: "999",
        expectedVersion: reviewed.version,
        expectedSourceId: sourceId,
        requestId
      })
    ).rejects.toThrow(/identity was already used/);
    const publishedIntake = (await getIntakeForReview(
      reviewPool,
      principal,
      captured.id
    )) as { version: string; generation: string };
    await expect(
      saveReviewDecisions(reviewPool, principal, {
        intakeId: captured.id,
        expectedGeneration: publishedIntake.generation,
        expectedVersion: publishedIntake.version,
        expectedSourceId: sourceId,
        decisions: manualReviewDecisions({
          ...review.metadata,
          revision: "B"
        }).decisions,
        unresolved: []
      })
    ).rejects.toThrow(/generation changed/);
    const adminGrant = await (
      await import("../database.server")
    ).withKnowledgeTransaction(reviewPool, principal, "read", (client) =>
      client.query(
        `SELECT id FROM knowledge."grant" WHERE "companyId"=$1 AND "sourceId"=$2 AND "documentId"=$3
          AND "subjectKind"='user' AND "subjectId"=$4 AND capability='admin' AND "revokedAt" IS NULL`,
        [companyId, sourceId, published.documentId, actorId]
      )
    );
    expect(adminGrant.rows).toHaveLength(0);
    const publishedEvent = {
      id: "manual-test-event",
      sourceId,
      entityType: "document",
      entityId: published.documentId,
      sourceVersion: reviewed.generation,
      eventType: "upsert" as const,
      payload: {}
    };
    const workerPrincipal = { companyId, callerId: "manual-index", sourceId };
    await expect(
      confirmOutboxApplied(
        ingestPool,
        workerPrincipal,
        publishedEvent,
        "manual-v1"
      )
    ).resolves.toBeUndefined();
    const matches = await (
      await import("../database.server")
    ).withKnowledgeTransaction(readPool, principal, "read", (client) =>
      lexicalSearch(client, companyId, [sourceId], "MTR-100", 10)
    );
    expect(matches.some((row) => row.documentId === published.documentId)).toBe(
      true
    );
    const version = await getAuthorizedDocumentVersion(
      readPool,
      principal,
      published.documentId,
      published.documentVersionId
    );
    expect(version?.reviewedMetadata).toMatchObject({
      partNumber: "MTR-100",
      revision: "A"
    });
    const deleted = await tombstoneManualDocument(reviewPool, principal, {
      documentId: published.documentId,
      sourceId,
      requestId: `delete-${captured.id}`
    });
    expect(deleted.tombstoned).toBe(true);
    // A deletion supersedes a pending publication event. Acknowledge the old
    // event without recreating data or blocking unrelated work forever.
    await expect(
      confirmOutboxApplied(
        ingestPool,
        workerPrincipal,
        publishedEvent,
        "manual-v1"
      )
    ).resolves.toBeUndefined();
    await expect(
      confirmOutboxApplied(
        ingestPool,
        workerPrincipal,
        { ...publishedEvent, eventType: "delete" },
        "manual-v1"
      )
    ).resolves.toBeUndefined();

    await expect(
      tombstoneManualDocument(reviewPool, principal, {
        documentId: published.documentId,
        sourceId,
        requestId: `delete-${captured.id}`
      })
    ).resolves.toEqual(deleted);
    await expect(
      publishReviewedIntake(reviewPool, principal, {
        intakeId: captured.id,
        expectedGeneration: reviewed.generation,
        expectedVersion: reviewed.version,
        expectedSourceId: sourceId,
        requestId: `republish-${captured.id}`
      })
    ).rejects.toThrow(/tombstoned|changed|could not be resolved/);
    await expect(
      getAuthorizedDocumentVersion(
        readPool,
        principal,
        published.documentId,
        published.documentVersionId
      )
    ).resolves.toBeNull();
  }, 20_000);
});
