-- Independently applied knowledge migration.
-- Outbox kinds consumed by cache invalidation rather than indexing delivery:
-- corrections, external group/board (ACL cohort) changes and new index
-- generations. Database triggers cannot observe these, so the outbox carries
-- them to the worker, which advances the affected source epochs.
SET LOCAL ROLE knowledge_migrate;
ALTER TABLE knowledge.outbox DROP CONSTRAINT IF EXISTS "outbox_eventType_check";
ALTER TABLE knowledge.outbox ADD CONSTRAINT "outbox_eventType_check"
  CHECK ("eventType" IN ('upsert','delete','acl-change','correction','board-change','index-version'));
RESET ROLE;
