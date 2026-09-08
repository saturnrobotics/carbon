-- Runtime policies also reference transaction-local identity getters. They
-- return NULL for the retention owner and expose no table or user information.
SET LOCAL ROLE knowledge_migrate;
GRANT EXECUTE ON FUNCTION knowledge.actor_id(),knowledge.company_id()
TO knowledge_retention_owner;
RESET ROLE;
