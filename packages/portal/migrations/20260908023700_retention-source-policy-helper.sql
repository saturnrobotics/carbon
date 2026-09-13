-- The source visibility policy was added after the foundation policies and is
-- also eligible for evaluation during retention-owner reads.
SET LOCAL ROLE knowledge_migrate;
GRANT EXECUTE ON FUNCTION knowledge.source_visible(text,text)
TO knowledge_retention_owner;
RESET ROLE;
