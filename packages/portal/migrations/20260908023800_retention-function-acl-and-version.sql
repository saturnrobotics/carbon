-- Function ownership changes require the new owner to set the ACL. Repair the
-- default PUBLIC execute grant and qualify the intake version increment, whose
-- joined source row also has a version column.
GRANT knowledge_retention_owner TO knowledge_migrate;
GRANT CREATE ON SCHEMA knowledge TO knowledge_retention_owner;
SET LOCAL ROLE knowledge_retention_owner;

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('knowledge.finalize_retention(jsonb)'::regprocedure)
    INTO definition;
  IF pg_catalog.strpos(definition,'version=version+1')=0 THEN
    RAISE EXCEPTION 'Unexpected retention finalizer definition';
  END IF;
  EXECUTE pg_catalog.replace(definition,'version=version+1','version=i.version+1');
END $$;

REVOKE ALL ON FUNCTION knowledge.retention_candidates(integer),
  knowledge.finalize_retention(jsonb),knowledge.cleanup_operational_retention(),
  knowledge.recovery_index_candidates(integer)
FROM PUBLIC,anon,authenticated,knowledge_read,knowledge_ingest,knowledge_review,
  knowledge_actions,knowledge_migrate;
GRANT EXECUTE ON FUNCTION knowledge.retention_candidates(integer),
  knowledge.finalize_retention(jsonb),knowledge.cleanup_operational_retention(),
  knowledge.recovery_index_candidates(integer) TO knowledge_maintenance;
ALTER DEFAULT PRIVILEGES FOR ROLE knowledge_retention_owner IN SCHEMA knowledge
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE CREATE ON SCHEMA knowledge FROM knowledge_retention_owner;
RESET ROLE;
REVOKE knowledge_retention_owner FROM knowledge_migrate;
