-- Reviewable parser evidence is bounded to one megabyte. The intake row keeps
-- only the much smaller extracted fields under its existing 64 KiB limit.
SET LOCAL ROLE knowledge_migrate;
ALTER TABLE knowledge.extraction DROP CONSTRAINT extraction_output_check;
ALTER TABLE knowledge.extraction ADD CONSTRAINT extraction_output_check
  CHECK (octet_length(output::text) <= 1000000);
RESET ROLE;
