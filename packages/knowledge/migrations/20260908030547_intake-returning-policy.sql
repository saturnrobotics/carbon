-- A direct review predicate lets INSERT ... RETURNING authorize the new row in
-- the same command snapshot. The prior helper re-selected the row invisibly.
SET LOCAL ROLE knowledge_migrate;
DROP POLICY "SELECT" ON knowledge.intake;
CREATE POLICY "SELECT" ON knowledge.intake FOR SELECT USING (
  current_user='knowledge_migrate'
  OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.actor_active("companyId")
    AND ("ownerId"=knowledge.actor_id() OR knowledge.can_access("companyId","sourceId",NULL,NULL,'review')))
);
RESET ROLE;
