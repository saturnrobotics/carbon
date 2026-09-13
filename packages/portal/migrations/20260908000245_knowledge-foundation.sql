-- Private knowledge schema; applied under a dedicated migration owner.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['knowledge_read','knowledge_ingest','knowledge_review','knowledge_actions','knowledge_migrate'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT',r); END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=r AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe knowledge policy role'; END IF;
  END LOOP;
END $$;
CREATE SCHEMA IF NOT EXISTS knowledge AUTHORIZATION knowledge_migrate;
REVOKE ALL ON SCHEMA knowledge FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA knowledge TO knowledge_read,knowledge_ingest,knowledge_review,knowledge_actions;
GRANT USAGE ON SCHEMA public, extensions TO knowledge_migrate;
GRANT REFERENCES ON public.company, public."user" TO knowledge_migrate;
GRANT EXECUTE ON FUNCTION public.id(text) TO knowledge_migrate;
SET LOCAL ROLE knowledge_migrate;
ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE IF NOT EXISTS knowledge."source" (
  "id" text NOT NULL DEFAULT public.id('ksrc'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('carbon','kanban','drive','upload','engineering','crm')),
  "externalId" text NOT NULL, "displayName" text NOT NULL,
  "ownerId" text NOT NULL REFERENCES public."user"(id), classification text NOT NULL,
  "providerPolicy" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("providerPolicy"::text)<=16384),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked')),
  "contentEpoch" bigint NOT NULL DEFAULT 1 CHECK ("contentEpoch">0),
  "aclEpoch" bigint NOT NULL DEFAULT 1 CHECK ("aclEpoch">0), cursor jsonb,
  PRIMARY KEY (id, "companyId"),UNIQUE ("companyId",kind,"externalId")
);

CREATE TABLE IF NOT EXISTS knowledge."identityBinding" (
  "id" text NOT NULL DEFAULT public.id('kidn'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  issuer text NOT NULL, subject text NOT NULL,
  "canonicalUserId" text NOT NULL REFERENCES public."user"(id), active boolean NOT NULL DEFAULT false,
  "revocationVersion" bigint NOT NULL DEFAULT 1 CHECK ("revocationVersion">0),
  PRIMARY KEY (id, "companyId"),UNIQUE ("companyId",issuer,subject)
);

CREATE TABLE IF NOT EXISTS knowledge."sourceUserBinding" (
  "id" text NOT NULL DEFAULT public.id('ksub'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text NOT NULL,
  "canonicalUserId" text NOT NULL REFERENCES public."user"(id), "sourceUserId" text NOT NULL,
  active boolean NOT NULL DEFAULT false, "bindingEvidence" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("bindingEvidence"::text) <= 65536),
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"), UNIQUE ("companyId","sourceId","canonicalUserId"), UNIQUE ("companyId","sourceId","sourceUserId")
);

CREATE TABLE IF NOT EXISTS knowledge."document" (
  "id" text NOT NULL DEFAULT public.id('kdoc'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text NOT NULL, "sourceItemId" text NOT NULL, title text NOT NULL,
  "ownerId" text NOT NULL REFERENCES public."user"(id),
  kind text NOT NULL CHECK (kind IN ('manual','procedure','note','specification','design','other')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','withdrawn')),
  classification text NOT NULL, "aclVersion" bigint NOT NULL DEFAULT 1 CHECK ("aclVersion">0),
  "currentVersionId" text, "deletedAt" timestamptz,
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"), UNIQUE ("companyId","sourceId","sourceItemId"), UNIQUE(id,"sourceId","companyId")
);

CREATE TABLE IF NOT EXISTS knowledge."documentVersion" (
  "id" text NOT NULL DEFAULT public.id('kver'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  
  "documentId" text NOT NULL, "sourceRevision" text NOT NULL,
  "contentHash" text NOT NULL, "objectKey" text NOT NULL, "objectGeneration" text NOT NULL,
  "MIME" text NOT NULL, "byteCount" bigint NOT NULL CHECK ("byteCount">=0), "extractedTextKey" text,
  "observedAt" timestamptz NOT NULL, "effectiveAt" timestamptz, "parserVersion" text NOT NULL,
  "extractionStatus" text NOT NULL CHECK ("extractionStatus" IN ('pending','ready','failed')),
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("documentId","companyId") REFERENCES knowledge."document"(id,"companyId"), UNIQUE ("companyId","documentId","sourceRevision"), UNIQUE (id,"documentId","companyId")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='document_current_version' AND conrelid='knowledge.document'::regclass) THEN
    ALTER TABLE knowledge.document ADD CONSTRAINT document_current_version FOREIGN KEY ("currentVersionId",id,"companyId")
      REFERENCES knowledge."documentVersion"(id,"documentId","companyId") DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS knowledge."chunk" (
  "id" text NOT NULL DEFAULT public.id('kchk'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  
  "documentId" text NOT NULL, "documentVersionId" text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal>=0), text text NOT NULL CHECK (octet_length(text)<=65536),
  heading text, page integer CHECK (page>0), bounds jsonb, "parentOrdinal" integer CHECK ("parentOrdinal">=0),
  "tokenCount" integer NOT NULL CHECK ("tokenCount">=0),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig,text)) STORED,
  embedding extensions.vector(768), "embeddingProfile" text NOT NULL,
  "indexGeneration" bigint NOT NULL CHECK ("indexGeneration">0),
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("documentId","companyId") REFERENCES knowledge."document"(id,"companyId"), FOREIGN KEY ("documentVersionId","documentId","companyId") REFERENCES knowledge."documentVersion"(id,"documentId","companyId"), UNIQUE ("companyId","documentVersionId",ordinal,"embeddingProfile")
);

CREATE TABLE IF NOT EXISTS knowledge."entity" (
  "id" text NOT NULL DEFAULT public.id('kent'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text NOT NULL, "sourceEntityId" text NOT NULL, "entityType" text NOT NULL,
  "sourceRevision" text NOT NULL, "displayName" text NOT NULL, "exactIdentifiers" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("exactIdentifiers"::text) <= 65536),
  "metadata" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("metadata"::text) <= 65536), "observedAt" timestamptz NOT NULL, "deletedAt" timestamptz,
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"), UNIQUE ("companyId","sourceId","entityType","sourceEntityId"), UNIQUE(id,"sourceId","companyId")
);

CREATE TABLE IF NOT EXISTS knowledge."entityLink" (
  "id" text NOT NULL DEFAULT public.id('klnk'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "entityId" text NOT NULL, "documentId" text NOT NULL, "documentVersionId" text,
  relation text NOT NULL CHECK (relation IN ('manual-for','specification-for','used-by','derived-from','related')),
  "applicability" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("applicability"::text) <= 65536), "verifiedBy" text REFERENCES public."user"(id), "verifiedAt" timestamptz,
  "provenance" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("provenance"::text) <= 65536),
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("entityId","companyId") REFERENCES knowledge."entity"(id,"companyId"), FOREIGN KEY ("documentId","companyId") REFERENCES knowledge."document"(id,"companyId"), FOREIGN KEY ("documentVersionId","documentId","companyId") REFERENCES knowledge."documentVersion"(id,"documentId","companyId")
);

CREATE TABLE IF NOT EXISTS knowledge."grant" (
  "id" text NOT NULL DEFAULT public.id('kgrt'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text NOT NULL, "documentId" text, "entityId" text,
  "subjectKind" text NOT NULL CHECK ("subjectKind" IN ('user','group')), "subjectId" text NOT NULL,
  capability text NOT NULL CHECK (capability IN ('read','review','publish','admin')),
  origin text NOT NULL CHECK (origin IN ('local','source')), "sourcePermissionId" text,
  "policyVersion" bigint NOT NULL CHECK ("policyVersion">0), "validUntil" timestamptz, "revokedAt" timestamptz,
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"), FOREIGN KEY ("documentId","sourceId","companyId") REFERENCES knowledge.document(id,"sourceId","companyId"), FOREIGN KEY ("entityId","sourceId","companyId") REFERENCES knowledge.entity(id,"sourceId","companyId"), CHECK ("documentId" IS NULL OR "entityId" IS NULL)
);

CREATE TABLE IF NOT EXISTS knowledge."groupMembership" (
  "id" text NOT NULL DEFAULT public.id('kgmem'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text, "groupId" text NOT NULL,
  "memberUserId" text NOT NULL REFERENCES public."user"(id), origin text NOT NULL CHECK (origin IN ('local','source')),
  "observedAt" timestamptz NOT NULL, "validUntil" timestamptz NOT NULL, "revokedAt" timestamptz,
  "policyVersion" bigint NOT NULL CHECK ("policyVersion">0),
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"), UNIQUE ("companyId","groupId","memberUserId"), CHECK (origin != 'source' OR "sourceId" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS knowledge."intake" (
  "id" text NOT NULL DEFAULT public.id('kin'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text NOT NULL, "ownerId" text NOT NULL REFERENCES public."user"(id),
  state text NOT NULL DEFAULT 'captured' CHECK (state IN ('captured','extracting','needs-review','ready','failed')),
  "inputRefs" jsonb NOT NULL DEFAULT '[]' CHECK (octet_length("inputRefs"::text) <= 65536), generation bigint NOT NULL DEFAULT 1 CHECK (generation>0),
  "extraction" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("extraction"::text) <= 65536), "reviewDecisions" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("reviewDecisions"::text) <= 65536), "unresolved" jsonb NOT NULL DEFAULT '[]' CHECK (octet_length("unresolved"::text) <= 65536), "idempotencyKey" text NOT NULL,
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"), UNIQUE ("companyId","ownerId","idempotencyKey")
);

CREATE TABLE IF NOT EXISTS knowledge."extraction" (
  "id" text NOT NULL DEFAULT public.id('kext'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  
  "intakeId" text NOT NULL, generation bigint NOT NULL CHECK (generation>0),
  "providerProfile" text NOT NULL, "sourceVersions" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("sourceVersions"::text) <= 65536), "output" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("output"::text) <= 65536),
  status text NOT NULL CHECK (status IN ('complete','failed')),
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("intakeId","companyId") REFERENCES knowledge."intake"(id,"companyId"), UNIQUE ("companyId","intakeId",generation)
);

CREATE TABLE IF NOT EXISTS knowledge."outbox" (
  "id" text NOT NULL DEFAULT public.id('kout'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text NOT NULL, "entityType" text NOT NULL, "entityId" text NOT NULL,
  "sourceVersion" text NOT NULL, "eventType" text NOT NULL CHECK ("eventType" IN ('upsert','delete','acl-change')),
  "payload" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("payload"::text) <= 65536), "availableAt" timestamptz NOT NULL DEFAULT now(), "deliveredAt" timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0), "leaseOwner" text, "leaseUntil" timestamptz,
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"), UNIQUE ("companyId","sourceId","entityType","entityId","sourceVersion","eventType")
);

CREATE TABLE IF NOT EXISTS knowledge."command" (
  "id" text NOT NULL DEFAULT public.id('kcmd'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "actorId" text NOT NULL REFERENCES public."user"(id),
  action text NOT NULL CHECK (action IN ('kanban.ticket.create','carbon.procurement.draft')),
  "targetSourceId" text NOT NULL, "targetResourceId" text NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("payload"::text) <= 65536), "payloadHash" text NOT NULL,
  "proposalVersion" bigint NOT NULL DEFAULT 1 CHECK ("proposalVersion">0), "idempotencyKey" text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','needs-clarification','ready','running','succeeded','failed','cancelled')),
  "executeAt" timestamptz, "resultRef" jsonb,
  PRIMARY KEY (id, "companyId"),FOREIGN KEY ("targetSourceId","companyId") REFERENCES knowledge."source"(id,"companyId"), UNIQUE ("companyId","actorId",action,"idempotencyKey")
);

CREATE TABLE IF NOT EXISTS knowledge."conversation" (
  "id" text NOT NULL DEFAULT public.id('kconv'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "ownerId" text NOT NULL REFERENCES public."user"(id),
  "compactState" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("compactState"::text) <= 65536), "expiresAt" timestamptz NOT NULL,
  PRIMARY KEY (id, "companyId")
);

CREATE TABLE IF NOT EXISTS knowledge."audit" (
  "id" text NOT NULL DEFAULT public.id('kaud'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  
  "actorId" text REFERENCES public."user"(id), "callerId" text NOT NULL,
  "requestId" text NOT NULL, action text NOT NULL, "targetRefs" jsonb NOT NULL DEFAULT '[]' CHECK (octet_length("targetRefs"::text) <= 65536),
  decision text NOT NULL CHECK (decision IN ('allow','deny','error')), "policyVersion" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}' CHECK (octet_length("metadata"::text) <= 65536),
  PRIMARY KEY (id, "companyId")
);

DO $$ DECLARE k record; BEGIN
 FOR k IN SELECT c.conrelid::regclass AS tbl,c.conname,
   string_agg(quote_ident(a.attname),',' ORDER BY u.ord) AS cols
   FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
   CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY u(num,ord)
   JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.num
   WHERE n.nspname='knowledge' AND c.contype='f' GROUP BY c.conrelid,c.conname LOOP
   EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %s (%s)',k.conname||'_idx',k.tbl,k.cols);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS chunk_fts_idx ON knowledge.chunk USING gin(fts);
CREATE INDEX IF NOT EXISTS entity_identifiers_idx ON knowledge.entity USING gin("exactIdentifiers");
CREATE INDEX IF NOT EXISTS document_published_idx ON knowledge.document("companyId",status,"currentVersionId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS grant_subject_idx ON knowledge."grant"("companyId","subjectKind","subjectId",capability);
CREATE INDEX IF NOT EXISTS group_member_idx ON knowledge."groupMembership"("companyId","memberUserId","groupId");
CREATE INDEX IF NOT EXISTS source_epochs_idx ON knowledge.source("companyId","contentEpoch","aclEpoch");
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON knowledge.outbox("availableAt","leaseUntil") WHERE "deliveredAt" IS NULL;
CREATE INDEX IF NOT EXISTS command_pending_idx ON knowledge.command("executeAt") WHERE status='ready';
CREATE INDEX IF NOT EXISTS conversation_expiry_idx ON knowledge.conversation("expiresAt");

-- Helpers are fixed-path, definer-owned and narrowly executable. The migration
-- role has an explicit SELECT policy so FORCE RLS does not recurse through ACLs.
CREATE OR REPLACE FUNCTION knowledge.actor_id() RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS
$$ SELECT nullif(current_setting('knowledge.actor_id',true),'') $$;
CREATE OR REPLACE FUNCTION knowledge.company_id() RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS
$$ SELECT nullif(current_setting('knowledge.company_id',true),'') $$;
CREATE OR REPLACE FUNCTION knowledge.actor_active(company text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT company = knowledge.company_id() AND EXISTS (
   SELECT 1 FROM knowledge."identityBinding" b
   WHERE b."companyId"=company AND b."canonicalUserId"=knowledge.actor_id() AND b.active
 )
$$;
CREATE OR REPLACE FUNCTION knowledge.machine_source(company text, source_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT company=knowledge.company_id() AND knowledge.actor_id() IS NULL AND EXISTS (
  SELECT 1 FROM knowledge.source s WHERE s.id=source_id AND s."companyId"=company AND s.status='active'
   AND s."providerPolicy"->'ingestDatabaseRoles' ? session_user::text
   AND s."providerPolicy"->'machineCallers' ? nullif(current_setting('knowledge.caller_id',true),'')
 )
$$;
CREATE OR REPLACE FUNCTION knowledge.has_grant(company text, source_id text, doc_id text, entity_id text, requested text, grant_origin text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT knowledge.actor_active(company) AND EXISTS (
  SELECT 1 FROM knowledge."grant" g WHERE g."companyId"=company AND g."sourceId"=source_id
   AND g.origin=grant_origin AND g."revokedAt" IS NULL AND (g."validUntil" IS NULL OR g."validUntil">now())
   AND (g.capability=requested OR g.capability='admin')
   AND ((g."documentId" IS NULL AND g."entityId" IS NULL)
     OR (doc_id IS NOT NULL AND g."documentId"=doc_id)
     OR (entity_id IS NOT NULL AND g."entityId"=entity_id))
   AND ((g."subjectKind"='user' AND g."subjectId"=knowledge.actor_id()) OR (g."subjectKind"='group' AND EXISTS (
     SELECT 1 FROM knowledge."groupMembership" m
     WHERE m."companyId"=company AND m."groupId"=g."subjectId" AND m."memberUserId"=knowledge.actor_id()
      AND m.origin=g.origin AND (m."sourceId" IS NULL OR m."sourceId"=source_id)
      AND m."revokedAt" IS NULL AND m."validUntil">now()
   )))
 )
$$;
CREATE OR REPLACE FUNCTION knowledge.can_access(company text, source_id text, doc_id text DEFAULT NULL, entity_id text DEFAULT NULL, requested text DEFAULT 'read') RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT knowledge.actor_active(company) AND EXISTS (
  SELECT 1 FROM knowledge.source s WHERE s.id=source_id AND s."companyId"=company AND s.status='active'
   AND knowledge.has_grant(company,source_id,doc_id,entity_id,requested,'local')
   AND (s.kind='upload' OR knowledge.has_grant(company,source_id,doc_id,entity_id,'read','source'))
 )
$$;
CREATE OR REPLACE FUNCTION knowledge.document_visible(company text, doc_id text, version_id text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT EXISTS (SELECT 1 FROM knowledge.document d JOIN knowledge."documentVersion" v
  ON v.id=d."currentVersionId" AND v."documentId"=d.id AND v."companyId"=d."companyId"
  WHERE d.id=doc_id AND d."companyId"=company AND d.status='published' AND d."deletedAt" IS NULL
   AND v."extractionStatus"='ready' AND (version_id IS NULL OR version_id=v.id)
   AND knowledge.can_access(company,d."sourceId",d.id))
$$;
CREATE OR REPLACE FUNCTION knowledge.document_ingest(company text, doc_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT EXISTS (SELECT 1 FROM knowledge.document d WHERE d.id=doc_id AND d."companyId"=company
  AND knowledge.machine_source(company,d."sourceId"))
$$;
CREATE OR REPLACE FUNCTION knowledge.document_review(company text, doc_id text, requested text DEFAULT 'review') RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT EXISTS (SELECT 1 FROM knowledge.document d WHERE d.id=doc_id AND d."companyId"=company
  AND d."deletedAt" IS NULL AND knowledge.can_access(company,d."sourceId",d.id,NULL,requested))
$$;
CREATE OR REPLACE FUNCTION knowledge.entity_visible(company text, entity_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT EXISTS (SELECT 1 FROM knowledge.entity e WHERE e.id=entity_id AND e."companyId"=company
  AND e."deletedAt" IS NULL AND knowledge.can_access(company,e."sourceId",NULL,e.id))
$$;
CREATE OR REPLACE FUNCTION knowledge.intake_access(company text, intake_id text, machine boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT EXISTS (SELECT 1 FROM knowledge.intake i WHERE i.id=intake_id AND i."companyId"=company
  AND CASE WHEN machine THEN knowledge.machine_source(company,i."sourceId") ELSE
   knowledge.actor_active(company) AND (i."ownerId"=knowledge.actor_id() OR knowledge.can_access(company,i."sourceId",NULL,NULL,'review')) END)
$$;
CREATE OR REPLACE FUNCTION knowledge.check_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$ BEGIN
 IF NEW.version <> OLD.version+1 THEN RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
   OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
   RAISE EXCEPTION 'Immutable identity changed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA knowledge FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA knowledge TO knowledge_read,knowledge_ingest,knowledge_review,knowledge_actions;

ALTER TABLE knowledge."source" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."source" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."source" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."source" TO knowledge_read;
GRANT SELECT ON knowledge."source" TO knowledge_ingest;
GRANT UPDATE (cursor,"contentEpoch","aclEpoch",version,"updatedAt","updatedBy") ON knowledge.source TO knowledge_ingest;
GRANT SELECT ON knowledge."source" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."source";
CREATE POLICY "SELECT" ON knowledge."source" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.can_access("companyId",id))) OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId",id))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.can_access("companyId",id,NULL,NULL,'review'))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."source";
CREATE POLICY "INSERT" ON knowledge."source" FOR INSERT WITH CHECK (false);
DROP POLICY IF EXISTS "UPDATE" ON knowledge."source";
CREATE POLICY "UPDATE" ON knowledge."source" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId",id)))) WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId",id))));
DROP POLICY IF EXISTS "DELETE" ON knowledge."source";
CREATE POLICY "DELETE" ON knowledge."source" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."source";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."source" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."identityBinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."identityBinding" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."identityBinding" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."identityBinding" TO knowledge_read;
DROP POLICY IF EXISTS "SELECT" ON knowledge."identityBinding";
CREATE POLICY "SELECT" ON knowledge."identityBinding" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.actor_active("companyId") AND "canonicalUserId"=knowledge.actor_id())));
DROP POLICY IF EXISTS "INSERT" ON knowledge."identityBinding";
CREATE POLICY "INSERT" ON knowledge."identityBinding" FOR INSERT WITH CHECK (false);
DROP POLICY IF EXISTS "UPDATE" ON knowledge."identityBinding";
CREATE POLICY "UPDATE" ON knowledge."identityBinding" FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "DELETE" ON knowledge."identityBinding";
CREATE POLICY "DELETE" ON knowledge."identityBinding" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."identityBinding";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."identityBinding" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."sourceUserBinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."sourceUserBinding" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."sourceUserBinding" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."sourceUserBinding" TO knowledge_read;
GRANT SELECT ON knowledge."sourceUserBinding" TO knowledge_ingest;
DROP POLICY IF EXISTS "SELECT" ON knowledge."sourceUserBinding";
CREATE POLICY "SELECT" ON knowledge."sourceUserBinding" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.actor_active("companyId") AND "canonicalUserId"=knowledge.actor_id() AND active)) OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."sourceUserBinding";
CREATE POLICY "INSERT" ON knowledge."sourceUserBinding" FOR INSERT WITH CHECK (false);
DROP POLICY IF EXISTS "UPDATE" ON knowledge."sourceUserBinding";
CREATE POLICY "UPDATE" ON knowledge."sourceUserBinding" FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "DELETE" ON knowledge."sourceUserBinding";
CREATE POLICY "DELETE" ON knowledge."sourceUserBinding" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."sourceUserBinding";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."sourceUserBinding" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."document" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."document" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."document" TO knowledge_read;
GRANT SELECT ON knowledge."document" TO knowledge_ingest;
GRANT INSERT ON knowledge."document" TO knowledge_ingest;
GRANT UPDATE ON knowledge."document" TO knowledge_ingest;
GRANT SELECT ON knowledge."document" TO knowledge_review;
GRANT INSERT ON knowledge."document" TO knowledge_review;
GRANT UPDATE ON knowledge."document" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."document";
CREATE POLICY "SELECT" ON knowledge."document" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.document_visible("companyId",id))) OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId",id))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."document";
CREATE POLICY "INSERT" ON knowledge."document" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId",id)) AND "createdBy"=knowledge.actor_id()));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."document";
CREATE POLICY "UPDATE" ON knowledge."document" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId",id)))) WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId",id))));
DROP POLICY IF EXISTS "DELETE" ON knowledge."document";
CREATE POLICY "DELETE" ON knowledge."document" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."document";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."document" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."documentVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."documentVersion" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."documentVersion" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."documentVersion" TO knowledge_read;
GRANT SELECT ON knowledge."documentVersion" TO knowledge_ingest;
GRANT INSERT ON knowledge."documentVersion" TO knowledge_ingest;
GRANT SELECT ON knowledge."documentVersion" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."documentVersion";
CREATE POLICY "SELECT" ON knowledge."documentVersion" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.document_visible("companyId","documentId",id))) OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.document_ingest("companyId","documentId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId","documentId"))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."documentVersion";
CREATE POLICY "INSERT" ON knowledge."documentVersion" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.document_ingest("companyId","documentId"))));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."documentVersion";
CREATE POLICY "UPDATE" ON knowledge."documentVersion" FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "DELETE" ON knowledge."documentVersion";
CREATE POLICY "DELETE" ON knowledge."documentVersion" FOR DELETE USING (false);
ALTER TABLE knowledge."chunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."chunk" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."chunk" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."chunk" TO knowledge_read;
GRANT SELECT ON knowledge."chunk" TO knowledge_ingest;
GRANT INSERT ON knowledge."chunk" TO knowledge_ingest;
GRANT SELECT ON knowledge."chunk" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."chunk";
CREATE POLICY "SELECT" ON knowledge."chunk" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.document_visible("companyId","documentId","documentVersionId"))) OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.document_ingest("companyId","documentId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId","documentId"))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."chunk";
CREATE POLICY "INSERT" ON knowledge."chunk" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.document_ingest("companyId","documentId"))));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."chunk";
CREATE POLICY "UPDATE" ON knowledge."chunk" FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "DELETE" ON knowledge."chunk";
CREATE POLICY "DELETE" ON knowledge."chunk" FOR DELETE USING (false);
ALTER TABLE knowledge."entity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."entity" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."entity" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."entity" TO knowledge_read;
GRANT SELECT ON knowledge."entity" TO knowledge_ingest;
GRANT INSERT ON knowledge."entity" TO knowledge_ingest;
GRANT UPDATE ON knowledge."entity" TO knowledge_ingest;
GRANT SELECT ON knowledge."entity" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."entity";
CREATE POLICY "SELECT" ON knowledge."entity" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.entity_visible("companyId",id))) OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.entity_visible("companyId",id))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."entity";
CREATE POLICY "INSERT" ON knowledge."entity" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."entity";
CREATE POLICY "UPDATE" ON knowledge."entity" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId")))) WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))));
DROP POLICY IF EXISTS "DELETE" ON knowledge."entity";
CREATE POLICY "DELETE" ON knowledge."entity" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."entity";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."entity" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."entityLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."entityLink" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."entityLink" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."entityLink" TO knowledge_read;
GRANT SELECT ON knowledge."entityLink" TO knowledge_ingest;
GRANT INSERT ON knowledge."entityLink" TO knowledge_ingest;
GRANT UPDATE ON knowledge."entityLink" TO knowledge_ingest;
GRANT SELECT ON knowledge."entityLink" TO knowledge_review;
GRANT INSERT ON knowledge."entityLink" TO knowledge_review;
GRANT UPDATE ON knowledge."entityLink" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."entityLink";
CREATE POLICY "SELECT" ON knowledge."entityLink" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.entity_visible("companyId","entityId") AND knowledge.document_visible("companyId","documentId","documentVersionId"))) OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.document_ingest("companyId","documentId") AND EXISTS (SELECT 1 FROM knowledge.entity e WHERE e.id="entityId" AND e."companyId"="entityLink"."companyId" AND knowledge.machine_source(e."companyId",e."sourceId")))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId","documentId"))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."entityLink";
CREATE POLICY "INSERT" ON knowledge."entityLink" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.document_ingest("companyId","documentId") AND EXISTS (SELECT 1 FROM knowledge.entity e WHERE e.id="entityId" AND e."companyId"="entityLink"."companyId" AND knowledge.machine_source(e."companyId",e."sourceId")))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId","documentId")) AND "createdBy"=knowledge.actor_id()));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."entityLink";
CREATE POLICY "UPDATE" ON knowledge."entityLink" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.document_ingest("companyId","documentId") AND EXISTS (SELECT 1 FROM knowledge.entity e WHERE e.id="entityId" AND e."companyId"="entityLink"."companyId" AND knowledge.machine_source(e."companyId",e."sourceId")))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId","documentId")))) WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.document_ingest("companyId","documentId") AND EXISTS (SELECT 1 FROM knowledge.entity e WHERE e.id="entityId" AND e."companyId"="entityLink"."companyId" AND knowledge.machine_source(e."companyId",e."sourceId")))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.document_review("companyId","documentId"))));
DROP POLICY IF EXISTS "DELETE" ON knowledge."entityLink";
CREATE POLICY "DELETE" ON knowledge."entityLink" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."entityLink";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."entityLink" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."grant" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."grant" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."grant" TO knowledge_ingest;
GRANT INSERT ON knowledge."grant" TO knowledge_ingest;
GRANT UPDATE ON knowledge."grant" TO knowledge_ingest;
GRANT SELECT ON knowledge."grant" TO knowledge_review;
GRANT INSERT ON knowledge."grant" TO knowledge_review;
GRANT UPDATE ON knowledge."grant" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."grant";
CREATE POLICY "SELECT" ON knowledge."grant" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId") AND origin='source')) OR (pg_has_role(current_user,'knowledge_review','member') AND (origin='local' AND knowledge.can_access("companyId","sourceId","documentId","entityId",'admin'))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."grant";
CREATE POLICY "INSERT" ON knowledge."grant" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId") AND origin='source')) OR (pg_has_role(current_user,'knowledge_review','member') AND (origin='local' AND knowledge.can_access("companyId","sourceId","documentId","entityId",'admin')) AND "createdBy"=knowledge.actor_id()));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."grant";
CREATE POLICY "UPDATE" ON knowledge."grant" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId") AND origin='source')) OR (pg_has_role(current_user,'knowledge_review','member') AND (origin='local' AND knowledge.can_access("companyId","sourceId","documentId","entityId",'admin')))) WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId") AND origin='source')) OR (pg_has_role(current_user,'knowledge_review','member') AND (origin='local' AND knowledge.can_access("companyId","sourceId","documentId","entityId",'admin'))));
DROP POLICY IF EXISTS "DELETE" ON knowledge."grant";
CREATE POLICY "DELETE" ON knowledge."grant" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."grant";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."grant" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."groupMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."groupMembership" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."groupMembership" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."groupMembership" TO knowledge_ingest;
GRANT INSERT ON knowledge."groupMembership" TO knowledge_ingest;
GRANT UPDATE ON knowledge."groupMembership" TO knowledge_ingest;
DROP POLICY IF EXISTS "SELECT" ON knowledge."groupMembership";
CREATE POLICY "SELECT" ON knowledge."groupMembership" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId") AND origin='source')));
DROP POLICY IF EXISTS "INSERT" ON knowledge."groupMembership";
CREATE POLICY "INSERT" ON knowledge."groupMembership" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId") AND origin='source')));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."groupMembership";
CREATE POLICY "UPDATE" ON knowledge."groupMembership" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId") AND origin='source'))) WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId") AND origin='source')));
DROP POLICY IF EXISTS "DELETE" ON knowledge."groupMembership";
CREATE POLICY "DELETE" ON knowledge."groupMembership" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."groupMembership";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."groupMembership" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."intake" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."intake" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."intake" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."intake" TO knowledge_ingest;
GRANT INSERT ON knowledge."intake" TO knowledge_ingest;
GRANT UPDATE ON knowledge."intake" TO knowledge_ingest;
GRANT SELECT ON knowledge."intake" TO knowledge_review;
GRANT INSERT ON knowledge."intake" TO knowledge_review;
GRANT UPDATE ON knowledge."intake" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."intake";
CREATE POLICY "SELECT" ON knowledge."intake" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.actor_active("companyId") AND ("ownerId"=knowledge.actor_id() OR knowledge.can_access("companyId","sourceId",NULL,NULL,'review')))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."intake";
CREATE POLICY "INSERT" ON knowledge."intake" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.actor_active("companyId") AND ("ownerId"=knowledge.actor_id() OR knowledge.can_access("companyId","sourceId",NULL,NULL,'review'))) AND "createdBy"=knowledge.actor_id()));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."intake";
CREATE POLICY "UPDATE" ON knowledge."intake" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.actor_active("companyId") AND ("ownerId"=knowledge.actor_id() OR knowledge.can_access("companyId","sourceId",NULL,NULL,'review'))))) WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.actor_active("companyId") AND ("ownerId"=knowledge.actor_id() OR knowledge.can_access("companyId","sourceId",NULL,NULL,'review')))));
DROP POLICY IF EXISTS "DELETE" ON knowledge."intake";
CREATE POLICY "DELETE" ON knowledge."intake" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."intake";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."intake" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."extraction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."extraction" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."extraction" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."extraction" TO knowledge_ingest;
GRANT INSERT ON knowledge."extraction" TO knowledge_ingest;
GRANT SELECT ON knowledge."extraction" TO knowledge_review;
DROP POLICY IF EXISTS "SELECT" ON knowledge."extraction";
CREATE POLICY "SELECT" ON knowledge."extraction" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.intake_access("companyId","intakeId",true))) OR (pg_has_role(current_user,'knowledge_review','member') AND (knowledge.intake_access("companyId","intakeId"))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."extraction";
CREATE POLICY "INSERT" ON knowledge."extraction" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.intake_access("companyId","intakeId",true))));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."extraction";
CREATE POLICY "UPDATE" ON knowledge."extraction" FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "DELETE" ON knowledge."extraction";
CREATE POLICY "DELETE" ON knowledge."extraction" FOR DELETE USING (false);
ALTER TABLE knowledge."outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."outbox" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."outbox" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."outbox" TO knowledge_ingest;
GRANT INSERT ON knowledge."outbox" TO knowledge_ingest;
GRANT UPDATE ON knowledge."outbox" TO knowledge_ingest;
DROP POLICY IF EXISTS "SELECT" ON knowledge."outbox";
CREATE POLICY "SELECT" ON knowledge."outbox" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."outbox";
CREATE POLICY "INSERT" ON knowledge."outbox" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."outbox";
CREATE POLICY "UPDATE" ON knowledge."outbox" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId")))) WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND (knowledge.machine_source("companyId","sourceId"))));
DROP POLICY IF EXISTS "DELETE" ON knowledge."outbox";
CREATE POLICY "DELETE" ON knowledge."outbox" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."outbox";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."outbox" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."command" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."command" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."command" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."command" TO knowledge_actions;
GRANT INSERT ON knowledge."command" TO knowledge_actions;
GRANT UPDATE ON knowledge."command" TO knowledge_actions;
DROP POLICY IF EXISTS "SELECT" ON knowledge."command";
CREATE POLICY "SELECT" ON knowledge."command" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_actions','member') AND (knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id())));
DROP POLICY IF EXISTS "INSERT" ON knowledge."command";
CREATE POLICY "INSERT" ON knowledge."command" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_actions','member') AND (knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id()) AND "createdBy"=knowledge.actor_id()));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."command";
CREATE POLICY "UPDATE" ON knowledge."command" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_actions','member') AND (knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id()))) WITH CHECK ((pg_has_role(current_user,'knowledge_actions','member') AND (knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id())));
DROP POLICY IF EXISTS "DELETE" ON knowledge."command";
CREATE POLICY "DELETE" ON knowledge."command" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."command";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."command" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."conversation" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."conversation" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."conversation" TO knowledge_read;
GRANT SELECT ON knowledge."conversation" TO knowledge_actions;
GRANT INSERT ON knowledge."conversation" TO knowledge_actions;
GRANT UPDATE ON knowledge."conversation" TO knowledge_actions;
DROP POLICY IF EXISTS "SELECT" ON knowledge."conversation";
CREATE POLICY "SELECT" ON knowledge."conversation" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_read','member') AND (knowledge.actor_active("companyId") AND "ownerId"=knowledge.actor_id() AND "expiresAt">now())) OR (pg_has_role(current_user,'knowledge_actions','member') AND (knowledge.actor_active("companyId") AND "ownerId"=knowledge.actor_id() AND "expiresAt">now())));
DROP POLICY IF EXISTS "INSERT" ON knowledge."conversation";
CREATE POLICY "INSERT" ON knowledge."conversation" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_actions','member') AND (knowledge.actor_active("companyId") AND "ownerId"=knowledge.actor_id() AND "expiresAt">now()) AND "createdBy"=knowledge.actor_id()));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."conversation";
CREATE POLICY "UPDATE" ON knowledge."conversation" FOR UPDATE USING ((pg_has_role(current_user,'knowledge_actions','member') AND (knowledge.actor_active("companyId") AND "ownerId"=knowledge.actor_id() AND "expiresAt">now()))) WITH CHECK ((pg_has_role(current_user,'knowledge_actions','member') AND (knowledge.actor_active("companyId") AND "ownerId"=knowledge.actor_id() AND "expiresAt">now())));
DROP POLICY IF EXISTS "DELETE" ON knowledge."conversation";
CREATE POLICY "DELETE" ON knowledge."conversation" FOR DELETE USING (false);
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."conversation";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."conversation" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
ALTER TABLE knowledge."audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."audit" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge."audit" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."audit" TO knowledge_ingest;
GRANT INSERT ON knowledge."audit" TO knowledge_ingest;
GRANT SELECT ON knowledge."audit" TO knowledge_review;
GRANT INSERT ON knowledge."audit" TO knowledge_review;
GRANT SELECT ON knowledge."audit" TO knowledge_actions;
GRANT INSERT ON knowledge."audit" TO knowledge_actions;
DROP POLICY IF EXISTS "SELECT" ON knowledge."audit";
CREATE POLICY "SELECT" ON knowledge."audit" FOR SELECT USING (current_user='knowledge_migrate' OR (pg_has_role(current_user,'knowledge_ingest','member') AND ("companyId"=knowledge.company_id() AND "callerId"=nullif(current_setting('knowledge.caller_id',true),'') AND ((knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id()) OR (knowledge.actor_id() IS NULL AND "actorId" IS NULL)))) OR (pg_has_role(current_user,'knowledge_review','member') AND ("companyId"=knowledge.company_id() AND "callerId"=nullif(current_setting('knowledge.caller_id',true),'') AND ((knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id()) OR (knowledge.actor_id() IS NULL AND "actorId" IS NULL)))) OR (pg_has_role(current_user,'knowledge_actions','member') AND ("companyId"=knowledge.company_id() AND "callerId"=nullif(current_setting('knowledge.caller_id',true),'') AND ((knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id()) OR (knowledge.actor_id() IS NULL AND "actorId" IS NULL)))));
DROP POLICY IF EXISTS "INSERT" ON knowledge."audit";
CREATE POLICY "INSERT" ON knowledge."audit" FOR INSERT WITH CHECK ((pg_has_role(current_user,'knowledge_ingest','member') AND ("companyId"=knowledge.company_id() AND "callerId"=nullif(current_setting('knowledge.caller_id',true),'') AND ((knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id()) OR (knowledge.actor_id() IS NULL AND "actorId" IS NULL)))) OR (pg_has_role(current_user,'knowledge_review','member') AND ("companyId"=knowledge.company_id() AND "callerId"=nullif(current_setting('knowledge.caller_id',true),'') AND ((knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id()) OR (knowledge.actor_id() IS NULL AND "actorId" IS NULL))) AND "createdBy"=knowledge.actor_id()) OR (pg_has_role(current_user,'knowledge_actions','member') AND ("companyId"=knowledge.company_id() AND "callerId"=nullif(current_setting('knowledge.caller_id',true),'') AND ((knowledge.actor_active("companyId") AND "actorId"=knowledge.actor_id()) OR (knowledge.actor_id() IS NULL AND "actorId" IS NULL))) AND "createdBy"=knowledge.actor_id()));
DROP POLICY IF EXISTS "UPDATE" ON knowledge."audit";
CREATE POLICY "UPDATE" ON knowledge."audit" FOR UPDATE USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "DELETE" ON knowledge."audit";
CREATE POLICY "DELETE" ON knowledge."audit" FOR DELETE USING (false);
RESET ROLE;
