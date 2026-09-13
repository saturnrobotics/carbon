-- Retention needs a function owner that can pass only purpose-built FORCE RLS
-- policies. The caller remains a separate NOLOGIN role with function execution
-- and no table privileges.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='knowledge_retention_owner') THEN
    CREATE ROLE knowledge_retention_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='knowledge_retention_owner' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe knowledge retention owner role';
  END IF;
END $$;

REVOKE knowledge_maintenance FROM knowledge_migrate;
GRANT knowledge_retention_owner TO knowledge_migrate;
SET LOCAL ROLE knowledge_migrate;

GRANT USAGE,CREATE ON SCHEMA knowledge TO knowledge_retention_owner;
GRANT USAGE ON SCHEMA knowledge_metering TO knowledge_retention_owner;
GRANT SELECT ON knowledge.source,knowledge.intake,knowledge.extraction,
  knowledge.document,knowledge."documentVersion",knowledge.conversation,
  knowledge.chunk,knowledge.audit,knowledge.outbox TO knowledge_retention_owner;
GRANT UPDATE ON knowledge.intake,knowledge."documentVersion",knowledge.audit TO knowledge_retention_owner;
GRANT DELETE ON knowledge.extraction,knowledge.conversation,knowledge.chunk,
  knowledge.outbox TO knowledge_retention_owner;
GRANT DELETE ON knowledge_metering."requestWindow" TO knowledge_retention_owner;

CREATE POLICY "RETENTION OWNER SELECT" ON knowledge.source FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER SELECT" ON knowledge.intake FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER UPDATE" ON knowledge.intake FOR UPDATE
  USING (current_user='knowledge_retention_owner') WITH CHECK (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER SELECT" ON knowledge.extraction FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER DELETE" ON knowledge.extraction FOR DELETE
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER SELECT" ON knowledge.document FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER SELECT" ON knowledge."documentVersion" FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER UPDATE" ON knowledge."documentVersion" FOR UPDATE
  USING (current_user='knowledge_retention_owner') WITH CHECK (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER SELECT" ON knowledge.conversation FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER DELETE" ON knowledge.conversation FOR DELETE
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER SELECT" ON knowledge.chunk FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER DELETE" ON knowledge.chunk FOR DELETE
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER SELECT" ON knowledge.audit FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER UPDATE" ON knowledge.audit FOR UPDATE
  USING (current_user='knowledge_retention_owner') WITH CHECK (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER SELECT" ON knowledge.outbox FOR SELECT
  USING (current_user='knowledge_retention_owner');
CREATE POLICY "RETENTION OWNER DELETE" ON knowledge.outbox FOR DELETE
  USING (current_user='knowledge_retention_owner');

ALTER FUNCTION knowledge.retention_candidates(integer) OWNER TO knowledge_retention_owner;
ALTER FUNCTION knowledge.finalize_retention(jsonb) OWNER TO knowledge_retention_owner;

CREATE FUNCTION knowledge.cleanup_operational_retention()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM knowledge_metering."requestWindow"
  WHERE minute < date_trunc('minute',clock_timestamp())-interval '2 minutes';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
ALTER FUNCTION knowledge.cleanup_operational_retention() OWNER TO knowledge_retention_owner;

CREATE FUNCTION knowledge.recovery_index_candidates(batch_limit integer DEFAULT 100)
RETURNS TABLE("companyId" text,"sourceId" text,"documentId" text,
  "versionId" text,"objectKey" text,generation text,"contentHash" text,
  "mimeType" text,"parserVersion" text)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT d."companyId",d."sourceId",d.id,v.id,v."objectKey",
    v."objectGeneration",v."contentHash",v."MIME",v."parserVersion"
  FROM knowledge.document d
  JOIN knowledge.source s ON s.id=d."sourceId" AND s."companyId"=d."companyId"
  JOIN knowledge."documentVersion" v ON v.id=d."currentVersionId"
    AND v."documentId"=d.id AND v."companyId"=d."companyId"
  WHERE s.status='active' AND d.status='published' AND d."deletedAt" IS NULL
    AND v."contentPurgedAt" IS NULL
  ORDER BY d."companyId",d."sourceId",d.id
  LIMIT LEAST(GREATEST(batch_limit,1),500)
$$;
ALTER FUNCTION knowledge.recovery_index_candidates(integer) OWNER TO knowledge_retention_owner;
REVOKE CREATE ON SCHEMA knowledge FROM knowledge_retention_owner;

REVOKE ALL ON FUNCTION knowledge.cleanup_operational_retention(),
  knowledge.recovery_index_candidates(integer) FROM PUBLIC,anon,authenticated,
  knowledge_read,knowledge_ingest,knowledge_review,knowledge_actions,knowledge_migrate;
GRANT EXECUTE ON FUNCTION knowledge.cleanup_operational_retention(),
  knowledge.recovery_index_candidates(integer) TO knowledge_maintenance;
RESET ROLE;
REVOKE knowledge_retention_owner FROM knowledge_migrate;
