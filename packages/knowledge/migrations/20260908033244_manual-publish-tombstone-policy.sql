-- Independently applied knowledge migration.
-- Tombstoning changes deletedAt, so the update check must authorize against
-- the durable source/document grant rather than published-row visibility.
SET LOCAL ROLE knowledge_migrate;

DROP POLICY IF EXISTS "UPDATE" ON knowledge.document;
CREATE POLICY "UPDATE" ON knowledge.document FOR UPDATE USING (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member')
    AND knowledge.can_access("companyId","sourceId",id,NULL,'publish'))
) WITH CHECK (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member')
    AND knowledge.can_access("companyId","sourceId",id,NULL,'publish'))
);

RESET ROLE;
