SET LOCAL ROLE knowledge_migrate;
ALTER TABLE knowledge."documentVersion"
  ADD COLUMN "reviewedMetadata" jsonb NOT NULL DEFAULT '{}'
  CHECK (
    jsonb_typeof("reviewedMetadata")='object'
    AND octet_length("reviewedMetadata"::text)<=16384
    AND ("reviewedMetadata"='{}'::jsonb OR (
      "reviewedMetadata" ?& ARRAY['title','manufacturer','partNumber','revision','machine']
      AND "reviewedMetadata" - ARRAY['title','manufacturer','partNumber','revision','machine']='{}'::jsonb
      AND jsonb_typeof("reviewedMetadata"->'title')='string'
      AND jsonb_typeof("reviewedMetadata"->'manufacturer')='string'
      AND jsonb_typeof("reviewedMetadata"->'partNumber')='string'
      AND jsonb_typeof("reviewedMetadata"->'revision')='string'
      AND jsonb_typeof("reviewedMetadata"->'machine')='string'
    ))
  );
CREATE UNIQUE INDEX audit_human_request_action_idx
  ON knowledge.audit("companyId","actorId","callerId","requestId",action)
  WHERE "actorId" IS NOT NULL;
RESET ROLE;
