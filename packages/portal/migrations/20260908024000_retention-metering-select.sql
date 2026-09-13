-- DELETE predicates require SELECT on the filtered timestamp column.
SET LOCAL ROLE knowledge_migrate;
GRANT SELECT ON knowledge_metering."requestWindow"
TO knowledge_retention_owner;
RESET ROLE;
