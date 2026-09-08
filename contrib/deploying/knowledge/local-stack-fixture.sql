-- Fixed, synthetic rows for the labelled local-only manual workflow stack.
UPDATE public."user" SET active=true WHERE id IN ('alice','bob','automation');

INSERT INTO knowledge."identityBinding" (
  id,"companyId","createdBy",issuer,subject,"canonicalUserId",active,
  "revocationVersion",capabilities
) VALUES (
  'e2e-bob-iap-binding','company-b','bob','https://cloud.google.com/iap',
  'subject-b','bob',true,1,
  ARRAY[
    'knowledge.read','knowledge.intake.capture','knowledge.intake.review',
    'knowledge.intake.publish','knowledge.document.delete',
    'knowledge.document.download'
  ]::text[]
)
ON CONFLICT ("companyId",issuer,subject) DO UPDATE SET
  active=true,
  capabilities=EXCLUDED.capabilities,
  version=knowledge."identityBinding".version+1;

INSERT INTO knowledge."identityBinding" (
  id,"companyId","createdBy",issuer,subject,"canonicalUserId",active,
  "revocationVersion",capabilities
) VALUES (
  'e2e-alice-iap-binding','company-a','alice','https://cloud.google.com/iap',
  'subject-a','alice',true,1,ARRAY['knowledge.read']::text[]
)
ON CONFLICT ("companyId",issuer,subject) DO UPDATE SET
  active=true,
  capabilities=EXCLUDED.capabilities,
  version=knowledge."identityBinding".version+1;

UPDATE knowledge.source SET
  status='active',
  "providerPolicy"='{"machineCallers":["local-indexer"],"ingestDatabaseRoles":["supabase_admin"]}'::jsonb,
  version=version+1
WHERE id='source-b' AND "companyId"='company-b';

INSERT INTO knowledge."grant" (
  id,"companyId","createdBy","sourceId","subjectKind","subjectId",
  capability,origin,"policyVersion"
) VALUES (
  'e2e-bob-admin','company-b','bob','source-b','user','bob','admin','local',1
)
ON CONFLICT (id,"companyId") DO UPDATE SET
  "revokedAt"=NULL,
  "validUntil"=NULL,
  capability='admin',
  version=knowledge."grant".version+1;

INSERT INTO knowledge_metering."requestPolicy" (
  "companyId",endpoint,"userPerMinute","companyPerMinute"
) VALUES ('company-b','knowledge.query',1000,10000)
ON CONFLICT ("companyId",endpoint) DO UPDATE SET
  "userPerMinute"=EXCLUDED."userPerMinute",
  "companyPerMinute"=EXCLUDED."companyPerMinute";
