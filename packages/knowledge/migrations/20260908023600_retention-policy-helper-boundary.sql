-- PostgreSQL may evaluate every permissive RLS expression even when the
-- retention-owner policy already permits a row. Give the non-login function
-- owner only the helper calls referenced by those existing read policies.
SET LOCAL ROLE knowledge_migrate;
GRANT EXECUTE ON FUNCTION
  knowledge.actor_active(text),
  knowledge.machine_source(text,text),
  knowledge.can_access(text,text,text,text,text),
  knowledge.document_visible(text,text,text),
  knowledge.document_ingest(text,text),
  knowledge.document_review(text,text,text),
  knowledge.intake_access(text,text,boolean)
TO knowledge_retention_owner;
RESET ROLE;
