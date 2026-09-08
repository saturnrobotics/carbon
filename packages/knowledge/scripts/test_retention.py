"""Retention and rebuild tests against the labelled disposable fixture."""
import json
import unittest

from test_schema import sql


class RetentionTests(unittest.TestCase):
    def test_retention_honors_holds_and_preserves_tombstones(self):
        result = sql("""
BEGIN;
INSERT INTO knowledge.intake(id,"companyId","createdBy","createdAt","sourceId","ownerId",state,"inputRefs","idempotencyKey") VALUES
 ('retention-old','company-a','alice',clock_timestamp()-interval '40 days','source-a','alice','ready','[{"kind":"object","objectKey":"raw/old.pdf","generation":"7"}]','retention-old'),
 ('retention-held','company-a','alice',clock_timestamp()-interval '40 days','source-a','alice','ready','[{"kind":"object","objectKey":"raw/held.pdf","generation":"8"}]','retention-held');
UPDATE knowledge.intake SET "legalHoldUntil"=clock_timestamp()+interval '1 day',version=version+1 WHERE id='retention-held';
INSERT INTO knowledge.conversation(id,"companyId","createdBy","ownerId","expiresAt") VALUES
 ('conversation-old','company-a','alice','alice',clock_timestamp()-interval '1 day'),
 ('conversation-held','company-a','alice','alice',clock_timestamp()-interval '1 day');
UPDATE knowledge.conversation SET "legalHoldUntil"=clock_timestamp()+interval '1 day',version=version+1 WHERE id='conversation-held';
INSERT INTO knowledge.audit(id,"companyId","createdBy","createdAt","callerId","requestId",action,"targetRefs",decision,"policyVersion",metadata) VALUES
 ('audit-old','company-a','alice',clock_timestamp()-interval '400 days','synthetic','retention-old','query','["sensitive-reference"]','allow','1','{"detail":"synthetic"}'),
 ('audit-held','company-a','alice',clock_timestamp()-interval '400 days','synthetic','retention-held','query','["held-reference"]','allow','1','{"detail":"held"}');
UPDATE knowledge.audit SET "legalHoldUntil"=clock_timestamp()+interval '1 day' WHERE id='audit-held';
INSERT INTO knowledge.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification,"deletedAt") VALUES
 ('document-retired','company-a','alice','source-a','retention-retired','Retired synthetic manual','alice','manual','withdrawn','internal',clock_timestamp()-interval '40 days');
INSERT INTO knowledge."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus") VALUES
 ('version-retired','company-a','alice','document-retired','1','synthetic-hash','documents/retired.pdf','9','application/pdf',10,clock_timestamp()-interval '40 days','synthetic','ready');
UPDATE knowledge.document SET "currentVersionId"='version-retired',version=version+1 WHERE id='document-retired';
INSERT INTO knowledge.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount","embeddingProfile","indexGeneration") VALUES
 ('chunk-retired','company-a','alice','document-retired','version-retired',0,'retired text',2,'synthetic',1);
INSERT INTO knowledge.outbox(id,"companyId","createdBy","createdAt","sourceId","entityType","entityId","sourceVersion","eventType","deliveredAt") VALUES
 ('outbox-old','company-a','alice',clock_timestamp()-interval '40 days','source-a','document','document-retired','1','delete',clock_timestamp()-interval '40 days');
INSERT INTO knowledge_metering."requestWindow"("companyId",endpoint,subject,minute,count) VALUES
 ('company-a','knowledge.query','user:alice',date_trunc('minute',clock_timestamp())-interval '3 minutes',1);
SET LOCAL ROLE knowledge_maintenance;
SELECT jsonb_agg(c ORDER BY "recordKind","recordId") FROM knowledge.retention_candidates(100) c
 WHERE "recordId" IN ('retention-old','retention-held','version-retired');
SELECT knowledge.finalize_retention('[{"recordKind":"intake","recordId":"retention-old","companyId":"company-a","objects":[{"objectKey":"raw/old.pdf","generation":"7"}]},{"recordKind":"document-version","recordId":"version-retired","companyId":"company-a","objects":[{"objectKey":"documents/retired.pdf","generation":"9"}]}]')
 || jsonb_build_object('requestWindows',knowledge.cleanup_operational_retention());
RESET ROLE;
SELECT jsonb_build_object(
 'oldIntakePurged',(SELECT "rawPurgedAt" IS NOT NULL FROM knowledge.intake WHERE id='retention-old'),
 'heldIntakePreserved',(SELECT "rawPurgedAt" IS NULL FROM knowledge.intake WHERE id='retention-held'),
 'expiredConversationDeleted',NOT EXISTS(SELECT 1 FROM knowledge.conversation WHERE id='conversation-old'),
 'heldConversationPreserved',EXISTS(SELECT 1 FROM knowledge.conversation WHERE id='conversation-held'),
 'auditRedacted',(SELECT metadata='{}' AND "targetRefs"='[]' FROM knowledge.audit WHERE id='audit-old'),
 'heldAuditPreserved',(SELECT metadata<>'{}' FROM knowledge.audit WHERE id='audit-held'),
 'chunkDeleted',NOT EXISTS(SELECT 1 FROM knowledge.chunk WHERE id='chunk-retired'),
 'tombstonePreserved',EXISTS(SELECT 1 FROM knowledge.document WHERE id='document-retired' AND "deletedAt" IS NOT NULL),
 'versionMarkedPurged',(SELECT "contentPurgedAt" IS NOT NULL FROM knowledge."documentVersion" WHERE id='version-retired'),
 'outboxDeleted',NOT EXISTS(SELECT 1 FROM knowledge.outbox WHERE id='outbox-old'),
 'requestWindowDeleted',NOT EXISTS(SELECT 1 FROM knowledge_metering."requestWindow" WHERE "companyId"='company-a' AND subject='user:alice' AND minute=date_trunc('minute',clock_timestamp())-interval '3 minutes')
);
ROLLBACK;
""")
        documents = [json.loads(line) for line in result.splitlines() if line.startswith(("[", "{"))]
        candidates, stats, state = documents
        self.assertEqual(sorted(item["recordId"] for item in candidates), ["retention-old", "version-retired"])
        self.assertGreaterEqual(stats["requestWindows"], 1)
        self.assertTrue(all(state.values()))

    def test_rebuild_candidates_preserve_tombstones_and_do_not_bypass_acl_delivery(self):
        candidates = json.loads(sql("SET ROLE knowledge_maintenance; SELECT coalesce(jsonb_agg(c ORDER BY \"documentId\"),'[]') FROM knowledge.recovery_index_candidates(100) c").splitlines()[-1])
        self.assertIn("doc-a", [candidate["documentId"] for candidate in candidates])
        self.assertIn("doc-hidden", [candidate["documentId"] for candidate in candidates])
        visible = sql("BEGIN; SET LOCAL ROLE knowledge_read; SET LOCAL knowledge.actor_id='alice'; SET LOCAL knowledge.company_id='company-a'; SELECT id FROM knowledge.document ORDER BY id; ROLLBACK")
        self.assertIn("doc-a", visible.splitlines())
        self.assertNotIn("doc-hidden", visible.splitlines())

    def test_runtime_roles_cannot_call_retention_or_recovery_functions(self):
        sql("SET ROLE knowledge_read; SELECT * FROM knowledge.retention_candidates(1)", succeeds=False)
        sql("SET ROLE knowledge_ingest; SELECT * FROM knowledge.recovery_index_candidates(1)", succeeds=False)


if __name__ == "__main__":
    unittest.main()
