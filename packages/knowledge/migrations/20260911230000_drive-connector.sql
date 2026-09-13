-- Independently applied knowledge migration.
-- Google Drive connector state: one explicit enrollment per Drive source
-- (scope, read-only OAuth scope, Secret Manager reference, user live-check
-- scope, reconciliation cadence, push-notification hint channel) and an item
-- ledger that records every observed file, folder and shortcut so that folder
-- and shared-drive permission changes can be applied to their descendants and
-- a periodic full listing can be reconciled against what was previously seen.
-- Enrollment is an administrator action through the privileged database path:
-- no runtime role can insert an enrollment, and the ingestion role may only
-- record sync outcomes on it.
SET LOCAL ROLE knowledge_migrate;

CREATE TABLE IF NOT EXISTS knowledge."driveEnrollment" (
  "id" text NOT NULL DEFAULT public.id('kdrv'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text NOT NULL,
  corpora text NOT NULL CHECK (corpora IN ('drive','user')),
  "driveId" text CHECK ("driveId" IS NULL OR length("driveId") BETWEEN 1 AND 256),
  "rootFolderIds" text[] NOT NULL DEFAULT '{}' CHECK (cardinality("rootFolderIds") <= 64),
  "oauthScope" text NOT NULL CHECK ("oauthScope" = 'https://www.googleapis.com/auth/drive.readonly'),
  "credentialSecretRef" text NOT NULL CHECK ("credentialSecretRef" ~ '^projects/[^/]+/secrets/[^/]+/versions/[0-9]+$'),
  "userAccessScope" text NOT NULL DEFAULT 'https://www.googleapis.com/auth/drive.metadata.readonly'
    CHECK ("userAccessScope" IN ('https://www.googleapis.com/auth/drive.metadata.readonly','https://www.googleapis.com/auth/drive.readonly')),
  "domainWideDelegation" boolean NOT NULL DEFAULT false,
  "notificationChannelId" text CHECK ("notificationChannelId" IS NULL OR length("notificationChannelId") BETWEEN 1 AND 256),
  "notificationTokenHash" text CHECK ("notificationTokenHash" IS NULL OR "notificationTokenHash" ~ '^[0-9a-f]{64}$'),
  "reconcileAfterHours" integer NOT NULL DEFAULT 24 CHECK ("reconcileAfterHours" BETWEEN 1 AND 168),
  "reconciledAt" timestamptz,
  "lastSyncAt" timestamptz,
  "lastSyncStatus" text CHECK ("lastSyncStatus" IS NULL OR "lastSyncStatus" IN ('succeeded','failed')),
  "lastSyncError" text CHECK ("lastSyncError" IS NULL OR length("lastSyncError") <= 500),
  PRIMARY KEY (id, "companyId"),
  FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"),
  UNIQUE ("companyId","sourceId"),
  CHECK ((corpora = 'drive' AND "driveId" IS NOT NULL)
      OR (corpora = 'user' AND "driveId" IS NULL AND cardinality("rootFolderIds") > 0)),
  CHECK (("notificationChannelId" IS NULL) = ("notificationTokenHash" IS NULL))
);
CREATE INDEX IF NOT EXISTS "driveEnrollment_source_idx" ON knowledge."driveEnrollment"("companyId","sourceId");

CREATE TABLE IF NOT EXISTS knowledge."driveItem" (
  "id" text NOT NULL DEFAULT public.id('kdit'),
  "companyId" text NOT NULL REFERENCES public.company(id),
  "createdBy" text NOT NULL REFERENCES public."user"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedBy" text REFERENCES public."user"(id),
  "updatedAt" timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  "sourceId" text NOT NULL,
  "fileId" text NOT NULL CHECK (length("fileId") BETWEEN 1 AND 256),
  "driveId" text,
  "mimeType" text NOT NULL CHECK (length("mimeType") <= 256),
  name text NOT NULL CHECK (length(name) <= 1024),
  "parentIds" text[] NOT NULL DEFAULT '{}' CHECK (cardinality("parentIds") <= 64),
  "shortcutTargetId" text,
  revision text,
  "contentHash" text,
  trashed boolean NOT NULL DEFAULT false,
  "inScope" boolean NOT NULL DEFAULT false,
  "aclEvaluated" boolean NOT NULL DEFAULT false,
  permissions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(permissions) = 'array' AND octet_length(permissions::text) <= 65536),
  "observedAt" timestamptz NOT NULL DEFAULT now(),
  "removedAt" timestamptz,
  PRIMARY KEY (id, "companyId"),
  FOREIGN KEY ("sourceId","companyId") REFERENCES knowledge."source"(id,"companyId"),
  UNIQUE ("companyId","sourceId","fileId")
);
CREATE INDEX IF NOT EXISTS "driveItem_parents_idx" ON knowledge."driveItem" USING gin ("parentIds");
CREATE INDEX IF NOT EXISTS "driveItem_shortcut_idx" ON knowledge."driveItem"("companyId","sourceId","shortcutTargetId") WHERE "shortcutTargetId" IS NOT NULL;

-- An enrollment can only describe a Drive source.
CREATE OR REPLACE FUNCTION knowledge.assert_drive_enrollment_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM knowledge.source s
    WHERE s.id = NEW."sourceId" AND s."companyId" = NEW."companyId" AND s.kind = 'drive'
  ) THEN
    RAISE EXCEPTION 'driveEnrollment requires a drive source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.assert_drive_enrollment_source() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS knowledge_drive_enrollment_source ON knowledge."driveEnrollment";
CREATE TRIGGER knowledge_drive_enrollment_source BEFORE INSERT OR UPDATE ON knowledge."driveEnrollment"
  FOR EACH ROW EXECUTE FUNCTION knowledge.assert_drive_enrollment_source();

DROP TRIGGER IF EXISTS knowledge_version ON knowledge."driveEnrollment";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."driveEnrollment" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();
DROP TRIGGER IF EXISTS knowledge_version ON knowledge."driveItem";
CREATE TRIGGER knowledge_version BEFORE UPDATE ON knowledge."driveItem" FOR EACH ROW EXECUTE FUNCTION knowledge.check_version();

ALTER TABLE knowledge."driveEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."driveEnrollment" FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge."driveItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge."driveItem" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON knowledge."driveEnrollment" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."driveEnrollment" TO knowledge_read;
GRANT SELECT ON knowledge."driveEnrollment" TO knowledge_review;
GRANT SELECT ON knowledge."driveEnrollment" TO knowledge_ingest;
GRANT UPDATE ("reconciledAt","lastSyncAt","lastSyncStatus","lastSyncError",version,"updatedAt","updatedBy")
  ON knowledge."driveEnrollment" TO knowledge_ingest;
CREATE POLICY "SELECT" ON knowledge."driveEnrollment" FOR SELECT USING (
  current_user='knowledge_migrate'
  OR (pg_has_role(current_user,'knowledge_read','member') AND knowledge.can_access("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_review','member') AND knowledge.can_access("companyId","sourceId"))
  OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
);
CREATE POLICY "INSERT" ON knowledge."driveEnrollment" FOR INSERT WITH CHECK (current_user='knowledge_migrate');
CREATE POLICY "UPDATE" ON knowledge."driveEnrollment" FOR UPDATE USING (
  current_user='knowledge_migrate'
  OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
) WITH CHECK (
  current_user='knowledge_migrate'
  OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
);
CREATE POLICY "DELETE" ON knowledge."driveEnrollment" FOR DELETE USING (false);

REVOKE ALL ON knowledge."driveItem" FROM PUBLIC,anon,authenticated;
GRANT SELECT ON knowledge."driveItem" TO knowledge_ingest;
GRANT INSERT ON knowledge."driveItem" TO knowledge_ingest;
GRANT UPDATE ON knowledge."driveItem" TO knowledge_ingest;
CREATE POLICY "SELECT" ON knowledge."driveItem" FOR SELECT USING (
  current_user='knowledge_migrate'
  OR (pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId"))
);
CREATE POLICY "INSERT" ON knowledge."driveItem" FOR INSERT WITH CHECK (
  pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId")
);
CREATE POLICY "UPDATE" ON knowledge."driveItem" FOR UPDATE USING (
  pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId")
) WITH CHECK (
  pg_has_role(current_user,'knowledge_ingest','member') AND knowledge.machine_source("companyId","sourceId")
);
CREATE POLICY "DELETE" ON knowledge."driveItem" FOR DELETE USING (false);
RESET ROLE;
