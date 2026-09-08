-- PostgreSQL checks helper execution permissions in the source SELECT policy
-- even when its machine branch authorizes the ingestion role. Keep row access
-- constrained by machine_source; grant only the referenced boolean helper.
SET LOCAL ROLE knowledge_migrate;
GRANT EXECUTE ON FUNCTION knowledge.source_visible(text,text) TO knowledge_ingest;
RESET ROLE;
