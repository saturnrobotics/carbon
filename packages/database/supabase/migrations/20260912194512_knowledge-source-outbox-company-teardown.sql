-- Knowledge source outbox: do not enqueue an event for a company that is being
-- deleted.
--
-- 20260911205347_knowledge-source-outbox.sql attached an AFTER ROW trigger to
-- receipt, receiptLine, item and purchaseOrder. Deleting a company
-- (settings.service.ts deleteSubsidiary -> DELETE FROM "company", reached from
-- x+/settings+/companies.delete.$id.tsx) CASCADEs to all four, so the trigger
-- runs for each child row AFTER the "company" row it references is already
-- gone, and its INSERT aborts the whole delete:
--
--   ERROR: insert or update on table "knowledgeSourceOutbox" violates foreign
--          key constraint "knowledgeSourceOutbox_companyId_fkey"
--   DETAIL: Key (companyId)=(...) is not present in table "company".
--
-- 20260827112750_prevent-item-delete-with-inventory.sql already established
-- that this cascade is a supported path and that a new constraint must not
-- break it. Every source table declares "companyId" NOT NULL with its own FK to
-- "company", so a company-wide cascade is the ONLY way this trigger can observe
-- a change whose company is absent.
--
-- The event is unrecordable rather than merely inconvenient: it names a
-- company, an entity and an outbox row that the same statement is deleting.
-- Dropping "knowledgeSourceOutbox_companyId_fkey" instead of adding this guard
-- was measured, not assumed — without that constraint the trigger leaves a
-- surviving item/"delete" row for a company and an entity that no longer exist,
-- which the company CASCADE can no longer reclaim and a consumer would lease
-- forever.
--
-- So the guard is a precondition, not an error handler: nothing is caught and
-- nothing is suppressed. A qualifying change to a LIVE company still records
-- exactly one event, and still fails loudly if that event cannot be written.
-- The lookup runs only after the per-table gates have decided an event is
-- warranted, so an ordinary non-qualifying write pays nothing for it. It reads
-- "company" the way this function already reads "receipt" — as its
-- SECURITY DEFINER owner, which is not subject to the caller's RLS, so a live
-- company can never look absent to it.
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

  -- The tenant is going away and is taking this change, its entity and this
  -- outbox row with it. See the header: a company-wide CASCADE is the only
  -- state in which the company can be missing here, and the event it would
  -- describe cannot be delivered to anyone. A change to a live company never
  -- reaches this branch.
  IF NOT EXISTS (SELECT 1 FROM "company" c WHERE c."id" = v_company_id) THEN
    RETURN NULL;
  END IF;

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
