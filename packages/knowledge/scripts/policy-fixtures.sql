-- Synthetic fixture reset is limited to rows with fixed synthetic IDs.
INSERT INTO knowledge."identityBinding" (id,"companyId","createdBy",issuer,subject,"canonicalUserId",active)
VALUES ('id-alice','company-a','alice','https://identity.example.com','subject-a','alice',true),
 ('id-bob','company-b','bob','https://identity.example.com','subject-b','bob',true),
 ('id-revoked','company-a','revoked','https://identity.example.com','subject-r','revoked',false)
ON CONFLICT DO NOTHING;
INSERT INTO knowledge.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
VALUES ('source-a','company-a','alice','drive','drive-a','Manuals A','alice','internal','{"machineCallers":["indexer-a"],"ingestDatabaseRoles":["supabase_admin"]}'),
 ('source-b','company-b','bob','upload','uploads-b','Manuals B','bob','internal','{}') ON CONFLICT DO NOTHING;
INSERT INTO knowledge."sourceUserBinding"(id,"companyId","createdBy","sourceId","canonicalUserId","sourceUserId",active)
VALUES ('source-binding-a','company-a','alice','source-a','alice','drive-user-alice',true)
ON CONFLICT DO NOTHING;
INSERT INTO knowledge.document(id,"companyId","createdBy","sourceId","sourceItemId",title,"ownerId",kind,status,classification)
VALUES ('doc-a','company-a','alice','source-a','manual-a','Visible manual','alice','manual','published','internal'),
 ('doc-hidden','company-a','alice','source-a','manual-hidden','Hidden manual','alice','manual','published','internal'),
 ('doc-b','company-b','bob','source-b','manual-b','Other company manual','bob','manual','published','internal') ON CONFLICT DO NOTHING;
INSERT INTO knowledge."documentVersion"(id,"companyId","createdBy","documentId","sourceRevision","contentHash","objectKey","objectGeneration","MIME","byteCount","observedAt","parserVersion","extractionStatus")
SELECT 'version-'||d.id,d."companyId",d."createdBy",d.id,'revision-1','identical-bytes','synthetic/manual.pdf','1','application/pdf',100,now(),'parser-1','ready'
FROM knowledge.document d WHERE d.id IN ('doc-a','doc-hidden','doc-b') ON CONFLICT DO NOTHING;
UPDATE knowledge.document SET "currentVersionId"='version-'||id,version=version+1
WHERE id IN ('doc-a','doc-hidden','doc-b') AND "currentVersionId" IS NULL;
INSERT INTO knowledge."grant"(id,"companyId","createdBy","sourceId","documentId","subjectKind","subjectId",capability,origin,"policyVersion")
VALUES ('grant-a-local','company-a','alice','source-a','doc-a','user','alice','read','local',1),
 ('grant-a-source','company-a','alice','source-a','doc-a','user','alice','read','source',1),
 ('grant-hidden-local','company-a','alice','source-a','doc-hidden','user','alice','read','local',1),
 ('grant-b-local','company-b','bob','source-b','doc-b','user','bob','read','local',1) ON CONFLICT DO NOTHING;
INSERT INTO knowledge.chunk(id,"companyId","createdBy","documentId","documentVersionId",ordinal,text,"tokenCount","embeddingProfile","indexGeneration")
SELECT 'chunk-'||d.id,d."companyId",d."createdBy",d.id,'version-'||d.id,0,d.title,3,'synthetic-768',1
FROM knowledge.document d WHERE d.id IN ('doc-a','doc-hidden','doc-b') ON CONFLICT DO NOTHING;

UPDATE knowledge."identityBinding" SET capabilities=ARRAY['knowledge.read','source.entities.search','kanban.ticket.create'],version=version+1 WHERE "canonicalUserId" IN ('alice','bob');
