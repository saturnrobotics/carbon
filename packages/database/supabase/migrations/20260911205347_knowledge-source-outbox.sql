-- Knowledge source outbox: the Carbon half of incremental knowledge indexing.
--
-- Carbon owns a transactional outbox. Reviewed AFTER ROW triggers on the source
-- tables the bounded knowledge reads project from (receipt, receiptLine, item,
-- purchaseOrder) record a durable reference to the changed entity in the SAME
-- transaction as the business change: a rolled-back write leaves no event and a
-- committed write leaves exactly one. Payloads carry references only — never a
-- document body or a row image. The consumer re-reads the live entity through
-- the bounded knowledge reads; the outbox says WHAT changed, not what it looks
-- like now, and no ordering between commits is promised or assumed.
--
-- Rows are written only by the trigger and consumed by server-side Kysely
-- (apps/erp/app/modules/knowledge/knowledge.events.server.ts): claim with a
-- lease, acknowledge after the consumer's own commit. Employees with
-- purchasing_view may read the outbox; no app role may insert, update or delete.

CREATE TABLE "knowledgeSourceOutbox" (
    "id" TEXT NOT NULL DEFAULT id('kso'),
    "companyId" TEXT NOT NULL,

    -- Source / entity / version / event-kind references (the dedupe identity).
    "source" TEXT NOT NULL DEFAULT 'carbon' CHECK ("source" = 'carbon'),
    "entityType" TEXT NOT NULL
        CHECK ("entityType" IN ('receipt', 'receiptLine', 'item', 'purchaseOrder')),
    "entityId" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "eventType" TEXT NOT NULL CHECK ("eventType" IN ('upsert', 'delete', 'acl-change')),
    -- References only (parent ids); bounded so a body can never be smuggled in.
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (octet_length("payload"::text) <= 4096),

    -- Delivery state: claim with a lease, acknowledge after the consumer commits.
    "availableAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "claimedAt" TIMESTAMP WITH TIME ZONE,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP WITH TIME ZONE,
    "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
    "deliveredAt" TIMESTAMP WITH TIME ZONE,

    "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedBy" TEXT REFERENCES "user"("id"),
    "updatedAt" TIMESTAMP WITH TIME ZONE,

    PRIMARY KEY ("id", "companyId"),
    FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE
);

-- The dedupe identity: the same change recorded twice is one event.
ALTER TABLE "knowledgeSourceOutbox" ADD CONSTRAINT "knowledgeSourceOutbox_dedupe_key"
    UNIQUE ("companyId", "source", "entityType", "entityId", "sourceVersion", "eventType");

CREATE INDEX "knowledgeSourceOutbox_companyId_idx" ON "knowledgeSourceOutbox" ("companyId");
CREATE INDEX "knowledgeSourceOutbox_createdBy_idx" ON "knowledgeSourceOutbox" ("createdBy");
CREATE INDEX "knowledgeSourceOutbox_updatedBy_idx" ON "knowledgeSourceOutbox" ("updatedBy");
-- The claim scan: pending rows for one company, oldest available first.
CREATE INDEX "knowledgeSourceOutbox_pending_idx" ON "knowledgeSourceOutbox" ("companyId", "availableAt")
    WHERE "deliveredAt" IS NULL;

ALTER TABLE "public"."knowledgeSourceOutbox" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "SELECT" ON "public"."knowledgeSourceOutbox"
FOR SELECT USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('purchasing_view'))::text[])
);
-- Deliberately no INSERT / UPDATE / DELETE policy: the trigger below writes rows
-- as its definer, and delivery state is maintained by server-side code. An app
-- role cannot enqueue, alter or acknowledge an event.

-- One reviewed trigger function for every source table. It decides, per table,
-- which changes the knowledge reads can observe, then records a reference.
--
-- sourceVersion is the row's bumped "updatedAt" (UTC, microseconds) — the
-- version a reader can see on the entity itself. A write that does not bump
-- "updatedAt" still changed the row, so it is versioned by the writing
-- transaction's identity instead of being silently merged into an already
-- delivered event. That identity is a dedupe key only, never an ordering.
--
-- SECURITY DEFINER for the same reason as sync_webhook_subscription: the
-- business write runs as the app role, which has no INSERT policy here.
--
-- Bulk reloads are skipped exactly as dispatch_event_batch skips them: a
-- dataset apply sets app.sync_in_progress, and a backup restore runs under
-- session_replication_role = 'replica' (where ordinary triggers do not fire).
-- A reloaded company is reconciled by the consumer's periodic sweep, not
-- replayed one row at a time.
CREATE OR REPLACE FUNCTION knowledge_source_outbox_enqueue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row RECORD;
  v_company_id TEXT;
  v_event_type TEXT;
  v_version TEXT;
  v_actor TEXT;
  v_payload JSONB := '{}'::jsonb;
  v_parent_status TEXT;
BEGIN
  IF current_setting('app.sync_in_progress', true) = 'true' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  v_company_id := v_row."companyId";
  IF v_company_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'receipt' THEN
    -- Only posted receipts are readable; leaving Posted is a tombstone.
    IF TG_OP = 'INSERT' THEN
      IF NEW."status" <> 'Posted' THEN RETURN NULL; END IF;
      v_event_type := 'upsert';
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW."status" <> 'Posted' AND OLD."status" <> 'Posted' THEN RETURN NULL; END IF;
      IF NEW."status" = OLD."status"
        AND NEW."receiptId" IS NOT DISTINCT FROM OLD."receiptId"
        AND NEW."postingDate" IS NOT DISTINCT FROM OLD."postingDate"
        AND NEW."sourceDocument" IS NOT DISTINCT FROM OLD."sourceDocument"
        AND NEW."sourceDocumentId" IS NOT DISTINCT FROM OLD."sourceDocumentId"
        AND NEW."sourceDocumentReadableId" IS NOT DISTINCT FROM OLD."sourceDocumentReadableId"
        AND NEW."supplierId" IS NOT DISTINCT FROM OLD."supplierId"
        AND NEW."locationId" IS NOT DISTINCT FROM OLD."locationId"
      THEN
        RETURN NULL;
      END IF;
      v_event_type := CASE WHEN NEW."status" = 'Posted' THEN 'upsert' ELSE 'delete' END;
    ELSE
      IF OLD."status" <> 'Posted' THEN RETURN NULL; END IF;
      v_event_type := 'delete';
    END IF;

  ELSIF TG_TABLE_NAME = 'receiptLine' THEN
    -- Lines are readable only through a posted receipt; posting the receipt
    -- itself announces the lines it already has.
    SELECT r."status" INTO v_parent_status
    FROM "receipt" r
    WHERE r."id" = v_row."receiptId" AND r."companyId" = v_company_id;
    IF v_parent_status IS DISTINCT FROM 'Posted' THEN
      RETURN NULL;
    END IF;
    v_event_type := CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END;
    v_payload := jsonb_build_object('receiptId', v_row."receiptId");

  ELSIF TG_TABLE_NAME = 'item' THEN
    -- The identity / revision projection the knowledge reads return.
    IF TG_OP = 'UPDATE'
      AND NEW."readableId" IS NOT DISTINCT FROM OLD."readableId"
      AND NEW."readableIdWithRevision" IS NOT DISTINCT FROM OLD."readableIdWithRevision"
      AND NEW."revision" IS NOT DISTINCT FROM OLD."revision"
      AND NEW."revisionStatus" IS NOT DISTINCT FROM OLD."revisionStatus"
      AND NEW."name" IS NOT DISTINCT FROM OLD."name"
      AND NEW."description" IS NOT DISTINCT FROM OLD."description"
      AND NEW."mpn" IS NOT DISTINCT FROM OLD."mpn"
      AND NEW."type" IS NOT DISTINCT FROM OLD."type"
      AND NEW."unitOfMeasureCode" IS NOT DISTINCT FROM OLD."unitOfMeasureCode"
      AND NEW."active" IS NOT DISTINCT FROM OLD."active"
    THEN
      RETURN NULL;
    END IF;
    v_event_type := CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END;

  ELSIF TG_TABLE_NAME = 'purchaseOrder' THEN
    -- The purchase status projection: status first, plus the fields read with it.
    IF TG_OP = 'UPDATE'
      AND NEW."status" IS NOT DISTINCT FROM OLD."status"
      AND NEW."purchaseOrderId" IS NOT DISTINCT FROM OLD."purchaseOrderId"
      AND NEW."revisionId" IS NOT DISTINCT FROM OLD."revisionId"
      AND NEW."orderDate" IS NOT DISTINCT FROM OLD."orderDate"
      AND NEW."supplierId" IS NOT DISTINCT FROM OLD."supplierId"
      AND NEW."supplierReference" IS NOT DISTINCT FROM OLD."supplierReference"
      AND NEW."closedAt" IS NOT DISTINCT FROM OLD."closedAt"
    THEN
      RETURN NULL;
    END IF;
    v_event_type := CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END;

  ELSE
    RAISE EXCEPTION 'knowledge_source_outbox_enqueue is not reviewed for table %', TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."updatedAt" IS NOT NULL AND NEW."updatedAt" IS DISTINCT FROM OLD."updatedAt" THEN
      v_version := to_char(NEW."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    ELSE
      v_version := 'xid:' || pg_current_xact_id()::text;
    END IF;
  ELSE
    v_version := to_char(
      COALESCE(v_row."updatedAt", v_row."createdAt") AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    );
  END IF;

  v_actor := COALESCE(v_row."updatedBy", v_row."createdBy");

  INSERT INTO "knowledgeSourceOutbox" (
    "companyId", "source", "entityType", "entityId", "sourceVersion", "eventType", "payload", "createdBy"
  )
  VALUES (
    v_company_id, 'carbon', TG_TABLE_NAME, v_row."id", v_version, v_event_type, v_payload, v_actor
  )
  ON CONFLICT ("companyId", "source", "entityType", "entityId", "sourceVersion", "eventType")
  DO UPDATE SET
    -- A pending duplicate is one event. An already delivered identity that is
    -- recorded again is re-armed rather than lost.
    "deliveredAt" = NULL,
    "availableAt" = NOW(),
    "claimedAt" = NULL,
    "leaseOwner" = NULL,
    "leaseExpiresAt" = NULL,
    "updatedBy" = EXCLUDED."createdBy",
    "updatedAt" = NOW()
  WHERE "knowledgeSourceOutbox"."deliveredAt" IS NOT NULL;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "knowledge_source_outbox_receipt_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON "receipt"
  FOR EACH ROW EXECUTE FUNCTION knowledge_source_outbox_enqueue();

CREATE TRIGGER "knowledge_source_outbox_receipt_line_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON "receiptLine"
  FOR EACH ROW EXECUTE FUNCTION knowledge_source_outbox_enqueue();

CREATE TRIGGER "knowledge_source_outbox_item_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON "item"
  FOR EACH ROW EXECUTE FUNCTION knowledge_source_outbox_enqueue();

CREATE TRIGGER "knowledge_source_outbox_purchase_order_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON "purchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION knowledge_source_outbox_enqueue();
