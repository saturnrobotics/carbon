-- Independently applied knowledge migration.
SET LOCAL ROLE knowledge_migrate;

DROP POLICY IF EXISTS "INSERT" ON knowledge.outbox;
CREATE POLICY "INSERT" ON knowledge.outbox FOR INSERT WITH CHECK (
  (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND "createdBy"=knowledge.actor_id() AND (
    ("entityType"='intake' AND EXISTS (
      SELECT 1 FROM knowledge.intake i WHERE i.id="entityId" AND i."companyId"=outbox."companyId"
        AND i."sourceId"=outbox."sourceId" AND knowledge.intake_access(i."companyId",i.id)
    ))
    OR ("entityType"='document' AND knowledge.can_access("companyId","sourceId",NULL,NULL,'publish'))
  ))
);

RESET ROLE;
