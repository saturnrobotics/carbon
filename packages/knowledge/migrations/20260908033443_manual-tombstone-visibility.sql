-- Independently applied knowledge migration.
-- PostgreSQL evaluates SELECT visibility for the new row of an UPDATE. Keep a
-- withdrawn row visible only to its current source/document publisher so the
-- tombstone can commit and be resolved idempotently by the worker.
SET LOCAL ROLE knowledge_migrate;

CREATE POLICY "REVIEW PUBLISH SELECT" ON knowledge.document FOR SELECT USING (
  pg_has_role(current_user,'knowledge_review','member')
  AND knowledge.can_access("companyId","sourceId",id,NULL,'publish')
);

RESET ROLE;
