-- Independently applied knowledge migration.
-- Allow a source publisher to resolve and finalize the exact immutable rows
-- created by the review transaction without granting document administration.
SET LOCAL ROLE knowledge_migrate;

DROP POLICY IF EXISTS "REVIEW CONFLICT SELECT" ON knowledge.document;
CREATE POLICY "REVIEW CONFLICT SELECT" ON knowledge.document FOR SELECT USING (
  pg_has_role(current_user,'knowledge_review','member')
  AND "deletedAt" IS NULL
  AND (
    knowledge.can_access("companyId","sourceId",id,NULL,'review')
    OR knowledge.can_access("companyId","sourceId",id,NULL,'publish')
  )
);

DROP POLICY IF EXISTS "UPDATE" ON knowledge.document;
CREATE POLICY "UPDATE" ON knowledge.document FOR UPDATE USING (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.document_review("companyId",id,'publish'))
) WITH CHECK (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.document_review("companyId",id,'publish'))
);

CREATE POLICY "REVIEW PUBLISH SELECT" ON knowledge."documentVersion" FOR SELECT USING (
  pg_has_role(current_user,'knowledge_review','member')
  AND knowledge.document_review("companyId","documentId",'publish')
);

CREATE POLICY "REVIEW PUBLISH SELECT" ON knowledge.chunk FOR SELECT USING (
  pg_has_role(current_user,'knowledge_review','member')
  AND knowledge.document_review("companyId","documentId",'publish')
);

RESET ROLE;
