-- Retention runs through two fixed-policy SECURITY DEFINER functions. The
-- maintenance login gets no table privilege and cannot choose an earlier cutoff.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='knowledge_maintenance') THEN
    CREATE ROLE knowledge_maintenance NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='knowledge_maintenance' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe knowledge maintenance role';
  END IF;
END $$;
GRANT knowledge_maintenance TO knowledge_migrate;

SET LOCAL ROLE knowledge_migrate;
GRANT USAGE ON SCHEMA knowledge TO knowledge_maintenance;

ALTER TABLE knowledge.source ADD COLUMN IF NOT EXISTS "legalHoldUntil" timestamptz;
ALTER TABLE knowledge.document ADD COLUMN IF NOT EXISTS "legalHoldUntil" timestamptz;
ALTER TABLE knowledge."documentVersion" ADD COLUMN IF NOT EXISTS "contentPurgedAt" timestamptz;
ALTER TABLE knowledge.intake ADD COLUMN IF NOT EXISTS "legalHoldUntil" timestamptz;
ALTER TABLE knowledge.intake ADD COLUMN IF NOT EXISTS "rawPurgedAt" timestamptz;
ALTER TABLE knowledge.conversation ADD COLUMN IF NOT EXISTS "legalHoldUntil" timestamptz;
ALTER TABLE knowledge.audit ADD COLUMN IF NOT EXISTS "legalHoldUntil" timestamptz;
ALTER TABLE knowledge.audit ADD COLUMN IF NOT EXISTS "metadataPurgedAt" timestamptz;

CREATE INDEX IF NOT EXISTS intake_retention_idx ON knowledge.intake(COALESCE("updatedAt","createdAt")) WHERE "rawPurgedAt" IS NULL;
CREATE INDEX IF NOT EXISTS document_retention_idx ON knowledge.document("deletedAt") WHERE "deletedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_retention_idx ON knowledge.audit("createdAt") WHERE "metadataPurgedAt" IS NULL;

CREATE OR REPLACE FUNCTION knowledge.retention_candidates(batch_limit integer DEFAULT 100)
RETURNS TABLE("recordKind" text,"recordId" text,"companyId" text,objects jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  WITH eligible_intake AS (
    SELECT i.id,i."companyId",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('objectKey',ref->>'objectKey','generation',ref->>'generation'))
        FROM jsonb_array_elements(i."inputRefs") ref
        WHERE ref->>'kind'='object' AND nullif(ref->>'objectKey','') IS NOT NULL AND nullif(ref->>'generation','') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM knowledge."documentVersion" v JOIN knowledge.document d
            ON d.id=v."documentId" AND d."companyId"=v."companyId"
            WHERE v."companyId"=i."companyId" AND v."objectKey"=ref->>'objectKey' AND v."objectGeneration"=ref->>'generation'
              AND d."deletedAt" IS NULL AND d.status<>'withdrawn')), '[]'::jsonb) AS objects
    FROM knowledge.intake i JOIN knowledge.source s ON s.id=i."sourceId" AND s."companyId"=i."companyId"
    WHERE i.state IN ('ready','failed') AND i."rawPurgedAt" IS NULL
      AND COALESCE(i."updatedAt",i."createdAt") <= clock_timestamp()-interval '30 days'
      AND (i."legalHoldUntil" IS NULL OR i."legalHoldUntil"<=clock_timestamp())
      AND (s."legalHoldUntil" IS NULL OR s."legalHoldUntil"<=clock_timestamp())
  ), eligible_version AS (
    SELECT v.id,v."companyId",
      CASE WHEN EXISTS (SELECT 1 FROM knowledge."documentVersion" other_v JOIN knowledge.document other_d
        ON other_d.id=other_v."documentId" AND other_d."companyId"=other_v."companyId"
        WHERE other_v."companyId"=v."companyId" AND other_v.id<>v.id
          AND other_v."objectKey"=v."objectKey" AND other_v."objectGeneration"=v."objectGeneration"
          AND other_d."deletedAt" IS NULL AND other_d.status<>'withdrawn') THEN '[]'::jsonb
        ELSE jsonb_build_array(jsonb_build_object('objectKey',v."objectKey",'generation',v."objectGeneration")) END AS objects
    FROM knowledge."documentVersion" v JOIN knowledge.document d ON d.id=v."documentId" AND d."companyId"=v."companyId"
    JOIN knowledge.source s ON s.id=d."sourceId" AND s."companyId"=d."companyId"
    WHERE v."contentPurgedAt" IS NULL AND d."deletedAt"<=clock_timestamp()-interval '30 days'
      AND (d."legalHoldUntil" IS NULL OR d."legalHoldUntil"<=clock_timestamp())
      AND (s."legalHoldUntil" IS NULL OR s."legalHoldUntil"<=clock_timestamp())
  )
  SELECT 'intake',id,"companyId",objects FROM eligible_intake
  UNION ALL
  SELECT 'document-version',id,"companyId",objects FROM eligible_version
  ORDER BY 1,3,2 LIMIT LEAST(GREATEST(batch_limit,1),500)
$$;

CREATE OR REPLACE FUNCTION knowledge.finalize_retention(records jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE intake_count integer:=0; version_count integer:=0; conversation_count integer:=0;
DECLARE chunk_count integer:=0; audit_count integer:=0; outbox_count integer:=0;
BEGIN
  IF jsonb_typeof(records)<>'array' OR jsonb_array_length(records)>500 THEN RAISE EXCEPTION 'Invalid retention receipt'; END IF;

  WITH selected AS (SELECT DISTINCT "recordId" id,"companyId" FROM jsonb_to_recordset(records) AS r("recordKind" text,"recordId" text,"companyId" text,objects jsonb) WHERE "recordKind"='intake'),
  eligible AS (SELECT i.id,i."companyId" FROM knowledge.intake i JOIN selected x USING(id,"companyId") JOIN knowledge.source s ON s.id=i."sourceId" AND s."companyId"=i."companyId"
    WHERE i.state IN ('ready','failed') AND i."rawPurgedAt" IS NULL AND COALESCE(i."updatedAt",i."createdAt")<=clock_timestamp()-interval '30 days'
      AND (i."legalHoldUntil" IS NULL OR i."legalHoldUntil"<=clock_timestamp()) AND (s."legalHoldUntil" IS NULL OR s."legalHoldUntil"<=clock_timestamp())),
  removed AS (DELETE FROM knowledge.extraction e USING eligible x WHERE e.id IS NOT NULL AND e."intakeId"=x.id AND e."companyId"=x."companyId" RETURNING e.id)
  SELECT count(*)::integer INTO intake_count FROM removed;
  WITH selected AS (SELECT DISTINCT "recordId" id,"companyId" FROM jsonb_to_recordset(records) AS r("recordKind" text,"recordId" text,"companyId" text,objects jsonb) WHERE "recordKind"='intake')
  UPDATE knowledge.intake i SET "inputRefs"='[]',extraction='{}',"rawPurgedAt"=clock_timestamp(),"updatedAt"=clock_timestamp(),version=version+1
    FROM selected x,knowledge.source s WHERE i.id=x.id AND i."companyId"=x."companyId" AND s.id=i."sourceId" AND s."companyId"=i."companyId"
      AND i.state IN ('ready','failed') AND i."rawPurgedAt" IS NULL AND COALESCE(i."updatedAt",i."createdAt")<=clock_timestamp()-interval '30 days'
      AND (i."legalHoldUntil" IS NULL OR i."legalHoldUntil"<=clock_timestamp()) AND (s."legalHoldUntil" IS NULL OR s."legalHoldUntil"<=clock_timestamp());
  GET DIAGNOSTICS intake_count = ROW_COUNT;

  WITH selected AS (SELECT DISTINCT "recordId" id,"companyId" FROM jsonb_to_recordset(records) AS r("recordKind" text,"recordId" text,"companyId" text,objects jsonb) WHERE "recordKind"='document-version')
  UPDATE knowledge."documentVersion" v SET "contentPurgedAt"=clock_timestamp(),"extractedTextKey"=NULL
    FROM selected x,knowledge.document d,knowledge.source s WHERE v.id=x.id AND v."companyId"=x."companyId" AND d.id=v."documentId" AND d."companyId"=v."companyId"
      AND s.id=d."sourceId" AND s."companyId"=d."companyId" AND v."contentPurgedAt" IS NULL AND d."deletedAt"<=clock_timestamp()-interval '30 days'
      AND (d."legalHoldUntil" IS NULL OR d."legalHoldUntil"<=clock_timestamp()) AND (s."legalHoldUntil" IS NULL OR s."legalHoldUntil"<=clock_timestamp());
  GET DIAGNOSTICS version_count = ROW_COUNT;

  WITH doomed AS (SELECT c.ctid FROM knowledge.conversation c WHERE c."expiresAt"<=clock_timestamp() AND (c."legalHoldUntil" IS NULL OR c."legalHoldUntil"<=clock_timestamp()) ORDER BY c."expiresAt" LIMIT 500)
  DELETE FROM knowledge.conversation c USING doomed d WHERE c.ctid=d.ctid;
  GET DIAGNOSTICS conversation_count = ROW_COUNT;

  WITH doomed AS (SELECT c.ctid FROM knowledge.chunk c JOIN knowledge.document d ON d.id=c."documentId" AND d."companyId"=c."companyId" JOIN knowledge.source s ON s.id=d."sourceId" AND s."companyId"=d."companyId"
    WHERE d."deletedAt"<=clock_timestamp()-interval '30 days' AND (d."legalHoldUntil" IS NULL OR d."legalHoldUntil"<=clock_timestamp()) AND (s."legalHoldUntil" IS NULL OR s."legalHoldUntil"<=clock_timestamp()) LIMIT 500)
  DELETE FROM knowledge.chunk c USING doomed d WHERE c.ctid=d.ctid;
  GET DIAGNOSTICS chunk_count = ROW_COUNT;

  WITH old AS (SELECT a.ctid FROM knowledge.audit a WHERE a."createdAt"<=clock_timestamp()-interval '365 days' AND a."metadataPurgedAt" IS NULL AND (a."legalHoldUntil" IS NULL OR a."legalHoldUntil"<=clock_timestamp()) ORDER BY a."createdAt" LIMIT 500)
  UPDATE knowledge.audit a SET "targetRefs"='[]',metadata='{}',"metadataPurgedAt"=clock_timestamp() FROM old WHERE a.ctid=old.ctid;
  GET DIAGNOSTICS audit_count = ROW_COUNT;

  WITH old AS (SELECT o.ctid FROM knowledge.outbox o WHERE o."deliveredAt"<=clock_timestamp()-interval '30 days' ORDER BY o."deliveredAt" LIMIT 500)
  DELETE FROM knowledge.outbox o USING old WHERE o.ctid=old.ctid;
  GET DIAGNOSTICS outbox_count = ROW_COUNT;

  RETURN jsonb_build_object('intakes',intake_count,'documentVersions',version_count,'conversations',conversation_count,'chunks',chunk_count,'audits',audit_count,'outbox',outbox_count);
END $$;

REVOKE ALL ON FUNCTION knowledge.retention_candidates(integer) FROM PUBLIC,anon,authenticated,knowledge_read,knowledge_ingest,knowledge_review,knowledge_actions;
REVOKE ALL ON FUNCTION knowledge.finalize_retention(jsonb) FROM PUBLIC,anon,authenticated,knowledge_read,knowledge_ingest,knowledge_review,knowledge_actions;
GRANT EXECUTE ON FUNCTION knowledge.retention_candidates(integer),knowledge.finalize_retention(jsonb) TO knowledge_maintenance;
RESET ROLE;
