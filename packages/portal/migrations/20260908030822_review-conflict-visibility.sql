-- Preserve current source authorization for owners while allowing PostgreSQL
-- to evaluate review-role ON CONFLICT checks on the exact event row.
SET LOCAL ROLE knowledge_migrate;
DROP POLICY "SELECT" ON knowledge.intake;
CREATE POLICY "SELECT" ON knowledge.intake FOR SELECT USING (
  current_user='knowledge_migrate'
  OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.actor_active("companyId") AND (
    ("ownerId"=knowledge.actor_id() AND knowledge.can_access("companyId","sourceId"))
    OR knowledge.can_access("companyId","sourceId",NULL,NULL,'review')
  ))
);
CREATE POLICY "REVIEW CONFLICT SELECT" ON knowledge.outbox FOR SELECT USING (
  pg_has_role(current_user,'knowledge_review','member') AND "createdBy"=knowledge.actor_id() AND (
    ("entityType"='intake' AND EXISTS (
      SELECT 1 FROM knowledge.intake i WHERE i.id="entityId" AND i."companyId"=outbox."companyId"
        AND i."sourceId"=outbox."sourceId" AND knowledge.intake_access(i."companyId",i.id)
    ))
    OR ("entityType"='document' AND knowledge.can_access("companyId","sourceId",NULL,NULL,'publish'))
  )
);
RESET ROLE;
