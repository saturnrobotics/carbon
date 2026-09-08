import type { Pool } from "pg";
import {
  type DatabasePrincipal,
  withKnowledgeTransaction
} from "./database.server";

export type AuthorizedDocumentVersion = {
  documentId: string;
  documentVersionId: string;
  sourceId: string;
  sourceKind: string;
  sourceItemId: string;
  title: string;
  contentHash: string;
  objectKey: string;
  objectGeneration: string;
  mimeType: string;
  byteCount: string;
  reviewedMetadata: Record<string, string>;
};

export async function getAuthorizedDocumentVersion(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  documentId: string,
  documentVersionId: string
): Promise<AuthorizedDocumentVersion | null> {
  return withKnowledgeTransaction(pool, principal, "read", async (client) => {
    const result = await client.query<AuthorizedDocumentVersion>(
      `SELECT d.id AS "documentId",v.id AS "documentVersionId",d."sourceId",s.kind AS "sourceKind",d."sourceItemId",d.title,
        v."contentHash",v."objectKey",v."objectGeneration",v."MIME" AS "mimeType",v."byteCount"::text AS "byteCount",v."reviewedMetadata"
       FROM knowledge.document d JOIN knowledge."documentVersion" v
         ON v."companyId"=d."companyId" AND v."documentId"=d.id
       JOIN knowledge.source s ON s."companyId"=d."companyId" AND s.id=d."sourceId"
       WHERE d."companyId"=$1 AND d.id=$2 AND v.id=$3 AND d."currentVersionId"=v.id
         AND d.status='published' AND d."deletedAt" IS NULL AND v."extractionStatus"='ready'`,
      [principal.companyId, documentId, documentVersionId]
    );
    return result.rows[0] ?? null;
  });
}

export async function tombstoneManualDocument(
  pool: Pool,
  principal: DatabasePrincipal & { actorId: string },
  input: { documentId: string; sourceId: string; requestId: string }
): Promise<{ documentId: string; tombstoned: true }> {
  return withKnowledgeTransaction(pool, principal, "write", async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${principal.companyId}:${principal.actorId}:${principal.callerId}:${input.requestId}`
    ]);
    const replay = await client.query<{ targetRefs: unknown }>(
      `SELECT "targetRefs" FROM knowledge.audit WHERE "companyId"=$1 AND "actorId"=$2
       AND "callerId"=$3 AND "requestId"=$4 AND action='knowledge.document.delete' LIMIT 1`,
      [
        principal.companyId,
        principal.actorId,
        principal.callerId,
        input.requestId
      ]
    );
    if (replay.rows[0]) {
      const targets = replay.rows[0].targetRefs;
      const target =
        Array.isArray(targets) && targets[0] && typeof targets[0] === "object"
          ? (targets[0] as Record<string, unknown>)
          : {};
      if (target.documentId !== input.documentId)
        throw new Error("delete request identity was already used");
      return { documentId: input.documentId, tombstoned: true };
    }
    const target = await client.query<{ sourceRevision: string }>(
      `SELECT v."sourceRevision" FROM knowledge.document d
       JOIN knowledge."documentVersion" v ON v."companyId"=d."companyId" AND v.id=d."currentVersionId"
       WHERE d."companyId"=$1 AND d.id=$2 AND d."sourceId"=$3 AND d.kind='manual'
         AND d."deletedAt" IS NULL AND d.status='published'
         AND knowledge.can_access(d."companyId",d."sourceId",d.id,NULL,'publish')
       FOR UPDATE OF d`,
      [principal.companyId, input.documentId, input.sourceId]
    );
    if (!target.rows[0]) throw new Error("manual cannot be deleted");
    const updated = await client.query(
      `UPDATE knowledge.document d SET status='withdrawn',"deletedAt"=now(),"aclVersion"=d."aclVersion"+1,
         "updatedBy"=$2,"updatedAt"=now(),version=d.version+1
       WHERE d."companyId"=$1 AND d.id=$3 AND d."sourceId"=$4 AND d.kind='manual'
         AND d."deletedAt" IS NULL AND d.status='published'`,
      [principal.companyId, principal.actorId, input.documentId, input.sourceId]
    );
    if (updated.rowCount !== 1) throw new Error("manual cannot be deleted");
    await client.query(
      `INSERT INTO knowledge.outbox("companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType",payload)
       VALUES ($1,$2,$3,'document',$4::text,$5::text,'delete',jsonb_build_object('documentId',$4::text))
       ON CONFLICT ("companyId","sourceId","entityType","entityId","sourceVersion","eventType") DO NOTHING`,
      [
        principal.companyId,
        principal.actorId,
        input.sourceId,
        input.documentId,
        target.rows[0].sourceRevision
      ]
    );
    await client.query(
      `INSERT INTO knowledge.audit("companyId","createdBy","actorId","callerId","requestId",action,"targetRefs",decision,"policyVersion",metadata)
       VALUES ($1,$2,$2,$3,$4,'knowledge.document.delete',jsonb_build_array(jsonb_build_object('documentId',$5::text)),'allow','manual-v1','{}')`,
      [
        principal.companyId,
        principal.actorId,
        principal.callerId,
        input.requestId,
        input.documentId
      ]
    );
    return { documentId: input.documentId, tombstoned: true };
  });
}
