SET LOCAL ROLE knowledge_migrate;
CREATE FUNCTION knowledge.bump_source_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row_value jsonb; company text; source_id text;
BEGIN
 row_value:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 company:=row_value->>'companyId'; source_id:=row_value->>'sourceId';
 IF TG_TABLE_NAME IN ('grant','groupMembership','sourceUserBinding') THEN
  UPDATE knowledge.source SET "aclEpoch"="aclEpoch"+1,version=version+1,"updatedAt"=clock_timestamp()
   WHERE "companyId"=company AND (source_id IS NULL OR id=source_id);
 ELSE
  UPDATE knowledge.source SET "contentEpoch"="contentEpoch"+1,version=version+1,"updatedAt"=clock_timestamp()
   WHERE "companyId"=company AND (source_id IS NULL OR id=source_id);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION knowledge.bump_source_epoch() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER knowledge_grant_epoch AFTER INSERT OR UPDATE OR DELETE ON knowledge."grant" FOR EACH ROW EXECUTE FUNCTION knowledge.bump_source_epoch();
CREATE TRIGGER knowledge_group_epoch AFTER INSERT OR UPDATE OR DELETE ON knowledge."groupMembership" FOR EACH ROW EXECUTE FUNCTION knowledge.bump_source_epoch();
CREATE TRIGGER knowledge_binding_epoch AFTER INSERT OR UPDATE OR DELETE ON knowledge."sourceUserBinding" FOR EACH ROW EXECUTE FUNCTION knowledge.bump_source_epoch();
CREATE TRIGGER knowledge_document_epoch AFTER INSERT OR UPDATE OR DELETE ON knowledge.document FOR EACH ROW EXECUTE FUNCTION knowledge.bump_source_epoch();
CREATE TRIGGER knowledge_entity_epoch AFTER INSERT OR UPDATE OR DELETE ON knowledge.entity FOR EACH ROW EXECUTE FUNCTION knowledge.bump_source_epoch();
CREATE TRIGGER knowledge_link_epoch AFTER INSERT OR UPDATE OR DELETE ON knowledge."entityLink" FOR EACH ROW EXECUTE FUNCTION knowledge.bump_source_epoch();

CREATE FUNCTION knowledge.source_policy_epoch() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW."providerPolicy" IS DISTINCT FROM OLD."providerPolicy" OR NEW.status IS DISTINCT FROM OLD.status OR NEW.classification IS DISTINCT FROM OLD.classification OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId" THEN
  NEW."aclEpoch":=GREATEST(NEW."aclEpoch",OLD."aclEpoch"+1);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.source_policy_epoch() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER knowledge_source_policy_epoch BEFORE UPDATE ON knowledge.source FOR EACH ROW EXECUTE FUNCTION knowledge.source_policy_epoch();
RESET ROLE;
