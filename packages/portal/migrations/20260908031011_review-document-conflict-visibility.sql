-- Permit review-role conflict checks on a draft/review document without
-- exposing it to readers. Published reader visibility remains unchanged.
SET LOCAL ROLE knowledge_migrate;
CREATE POLICY "REVIEW CONFLICT SELECT" ON knowledge.document FOR SELECT USING (
  pg_has_role(current_user,'knowledge_review','member')
  AND "deletedAt" IS NULL
  AND knowledge.can_access("companyId","sourceId",id,NULL,'review')
);
RESET ROLE;
