-- Prevent a policy-authorized old row being moved behind another resource ACL.
SET LOCAL ROLE knowledge_migrate;
CREATE OR REPLACE FUNCTION knowledge.check_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE field text; before_row jsonb := to_jsonb(OLD); after_row jsonb := to_jsonb(NEW);
BEGIN
 IF NEW.version <> OLD.version+1 THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001'; END IF;
 FOREACH field IN ARRAY ARRAY['id','companyId','createdBy','createdAt','sourceId','targetSourceId',
  'ownerId','actorId','entityId','documentId','intakeId','canonicalUserId','issuer','subject',
  'groupId','memberUserId','origin','action','idempotencyKey'] LOOP
  IF after_row->field IS DISTINCT FROM before_row->field THEN
   RAISE EXCEPTION 'Immutable identity or policy target changed' USING ERRCODE='23514';
  END IF;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['contentEpoch','aclEpoch','aclVersion','revocationVersion','policyVersion','generation','proposalVersion'] LOOP
  IF before_row ? field AND (after_row->>field)::bigint < (before_row->>field)::bigint THEN
   RAISE EXCEPTION 'Version cannot move backwards' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
RESET ROLE;
