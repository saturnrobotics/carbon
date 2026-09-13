-- Review transactions enqueue idempotent intake/publication events with ON
-- CONFLICT DO NOTHING. PostgreSQL requires SELECT privilege for that conflict
-- check; RLS still exposes no outbox rows to the review role.
GRANT SELECT ON knowledge.outbox TO knowledge_review;
