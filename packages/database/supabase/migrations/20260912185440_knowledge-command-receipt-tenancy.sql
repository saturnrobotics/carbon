-- knowledgeCommandReceipt: bring the command receipt up to Carbon's tenancy and
-- audit conventions, and record which payload contract produced it.
--
-- The table was created by 20260908004744_knowledge-command-receipts.sql with a
-- single-column primary key and no index on either foreign key. Every other
-- tenant-scoped table (including its sibling knowledgeProcurementSchedule) keys
-- on ("id", "companyId") and indexes "companyId" plus each FK, so the receipt
-- lookup on the command path — (companyId, actorId, action, idempotencyKey) —
-- was served only by the unique constraint while the tenancy of a bare id read
-- was unenforced.
--
-- "version" records the payload contract the receipt was written under. A replay
-- of a command whose contract has since changed must be recognizable as such
-- rather than silently answered with an order built from different rules; the
-- schedule table already carries the same column for the same reason.

ALTER TABLE public."knowledgeCommandReceipt"
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1 CHECK (version > 0);

-- Nothing references this key (verified: no FK targets the table), so the swap
-- to the composite key is a local change.
ALTER TABLE public."knowledgeCommandReceipt"
  DROP CONSTRAINT IF EXISTS "knowledgeCommandReceipt_pkey";
ALTER TABLE public."knowledgeCommandReceipt"
  ADD PRIMARY KEY ("id", "companyId");

CREATE INDEX IF NOT EXISTS "knowledgeCommandReceipt_companyId_idx"
  ON public."knowledgeCommandReceipt" ("companyId");
CREATE INDEX IF NOT EXISTS "knowledgeCommandReceipt_actorId_idx"
  ON public."knowledgeCommandReceipt" ("actorId");
