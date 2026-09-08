SET LOCAL ROLE knowledge_migrate;
ALTER TABLE knowledge."identityBinding" ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}' CHECK(cardinality(capabilities)<=100);
-- Capabilities are administrator-provisioned app ceilings. Source services still
-- enforce current operation/resource permissions; no runtime role can edit these.
RESET ROLE;
