-- Carbon's invoker ID generator resolves a UUID conversion helper in public.
-- Schema USAGE does not grant access to business tables or their mutators.
GRANT USAGE ON SCHEMA public, extensions TO knowledge_ingest,knowledge_review,knowledge_actions;
DO $id_helper$
BEGIN
 IF to_regprocedure('public.uuid_to_base58(uuid)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION public.uuid_to_base58(uuid) TO knowledge_migrate,knowledge_ingest,knowledge_review,knowledge_actions;
 END IF;
 IF to_regprocedure('extensions.uuid_generate_v4()') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION extensions.uuid_generate_v4() TO knowledge_migrate,knowledge_ingest,knowledge_review,knowledge_actions;
 END IF;
END
$id_helper$;
