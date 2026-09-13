-- Independently applied knowledge migration.
--
-- knowledge."identityBinding".id defaults to Carbon's invoker ID generator
-- public.id(text), which resolves public.uuid_to_base58(uuid) and
-- extensions.uuid_generate_v4(). 20260908030917_runtime-id-helper-boundary.sql
-- granted exactly that closure to the runtime write roles, but
-- knowledge_enrollment_owner is created later, by
-- 20260911204358_workforce-identity-enrollment.sql, and was never added to the
-- list. It is the only writer of that table, so against a real Carbon database
-- every knowledge.enroll_workforce_identity insert fails with "permission
-- denied for schema extensions" and no workforce identity can be enrolled.
--
-- The disposable test database replaces public.id with a gen_random_uuid()
-- definition that needs neither helper (packages/knowledge/scripts/bootstrap-test.sql),
-- which is why the enrollment suites pass without these grants.
--
-- Schema USAGE does not grant access to business tables or their mutators, and
-- the owner keeps NOBYPASSRLS with INSERT/UPDATE confined to its own policies.
GRANT USAGE ON SCHEMA extensions TO knowledge_enrollment_owner;
DO $id_helper$
BEGIN
 IF to_regprocedure('public.uuid_to_base58(uuid)') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION public.uuid_to_base58(uuid) TO knowledge_enrollment_owner;
 END IF;
 IF to_regprocedure('extensions.uuid_generate_v4()') IS NOT NULL THEN
  GRANT EXECUTE ON FUNCTION extensions.uuid_generate_v4() TO knowledge_enrollment_owner;
 END IF;
END
$id_helper$;
