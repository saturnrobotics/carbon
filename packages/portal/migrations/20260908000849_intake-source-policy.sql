-- Ownership of an intake does not override the imported source's access policy.
SET LOCAL ROLE knowledge_migrate;
CREATE OR REPLACE FUNCTION knowledge.intake_access(company text, intake_id text, machine boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT EXISTS (SELECT 1 FROM knowledge.intake i WHERE i.id=intake_id AND i."companyId"=company
  AND CASE WHEN machine THEN knowledge.machine_source(company,i."sourceId") ELSE
   (i."ownerId"=knowledge.actor_id() AND knowledge.can_access(company,i."sourceId"))
   OR knowledge.can_access(company,i."sourceId",NULL,NULL,'review') END)
$$;
DROP POLICY "SELECT" ON knowledge.intake;
CREATE POLICY "SELECT" ON knowledge.intake FOR SELECT USING (
 current_user='knowledge_migrate'
 OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
 OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.intake_access("companyId",id))
);
DROP POLICY "INSERT" ON knowledge.intake;
CREATE POLICY "INSERT" ON knowledge.intake FOR INSERT WITH CHECK (
 (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
 OR (pg_has_role(current_user,'knowledge_review','member') AND "createdBy"=knowledge.actor_id()
  AND (("ownerId"=knowledge.actor_id() AND knowledge.can_access("companyId","sourceId"))
   OR knowledge.can_access("companyId","sourceId",NULL,NULL,'review')))
);
DROP POLICY "UPDATE" ON knowledge.intake;
CREATE POLICY "UPDATE" ON knowledge.intake FOR UPDATE USING (
 (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
 OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.intake_access("companyId",id))
) WITH CHECK (
 (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
 OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.intake_access("companyId",id))
);
RESET ROLE;
