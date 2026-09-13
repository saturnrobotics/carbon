-- Independently applied knowledge migration.
-- Runtime review publishing remains RLS-bound while allowing one transaction to
-- create an immutable document version and its search projection.
SET LOCAL ROLE knowledge_migrate;

GRANT UPDATE ON knowledge.source TO knowledge_review;
DROP POLICY IF EXISTS "UPDATE" ON knowledge.source;
CREATE POLICY "UPDATE" ON knowledge.source FOR UPDATE USING (
  current_user='knowledge_migrate'
  OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId",id))
  OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.can_access("companyId",id,NULL,NULL,'admin'))
) WITH CHECK (
  current_user='knowledge_migrate'
  OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId",id))
  OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.can_access("companyId",id,NULL,NULL,'admin'))
);

DROP POLICY IF EXISTS "INSERT" ON knowledge.document;
CREATE POLICY "INSERT" ON knowledge.document FOR INSERT WITH CHECK (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND "createdBy"=knowledge.actor_id()
    AND knowledge.can_access("companyId","sourceId",NULL,NULL,'publish'))
);

GRANT INSERT ON knowledge."documentVersion" TO knowledge_review;
DROP POLICY IF EXISTS "INSERT" ON knowledge."documentVersion";
CREATE POLICY "INSERT" ON knowledge."documentVersion" FOR INSERT WITH CHECK (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.document_ingest("companyId","documentId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND "createdBy"=knowledge.actor_id()
    AND knowledge.document_review("companyId","documentId",'publish'))
);

GRANT INSERT ON knowledge.chunk TO knowledge_review;
DROP POLICY IF EXISTS "INSERT" ON knowledge.chunk;
CREATE POLICY "INSERT" ON knowledge.chunk FOR INSERT WITH CHECK (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.document_ingest("companyId","documentId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND "createdBy"=knowledge.actor_id()
    AND knowledge.document_review("companyId","documentId",'publish'))
);

GRANT INSERT ON knowledge.outbox TO knowledge_review;
DROP POLICY IF EXISTS "INSERT" ON knowledge.outbox;
CREATE POLICY "INSERT" ON knowledge.outbox FOR INSERT WITH CHECK (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND "createdBy"=knowledge.actor_id()
    AND knowledge.can_access("companyId","sourceId",NULL,NULL,'publish'))
);

RESET ROLE;
