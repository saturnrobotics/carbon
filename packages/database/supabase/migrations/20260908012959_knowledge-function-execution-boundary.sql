-- PostgreSQL PUBLIC is every role, including newly provisioned read-only services.
-- Preserve existing callers of legacy public routines, but make the new knowledge
-- roles opt in explicitly. Table-level read grants alone do not close this path.
DO $boundary$
DECLARE routine record; application_roles text;
BEGIN
 SELECT string_agg(format('%I',r.rolname),',') INTO application_roles
 FROM pg_roles r
 WHERE r.rolname NOT LIKE 'knowledge\_%' ESCAPE '\'
 AND NOT EXISTS (
  SELECT 1 FROM pg_roles restricted
  WHERE restricted.rolname IN ('knowledge_read','knowledge_ingest','knowledge_review','knowledge_actions','knowledge_migrate')
    AND pg_has_role(r.oid,restricted.oid,'member')
 );
 FOR routine IN
  SELECT p.oid, p.prokind,
    format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS signature
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind IN ('f','p')
   AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
 LOOP
  IF application_roles IS NOT NULL THEN
   EXECUTE format('GRANT EXECUTE ON %s %s TO %s',CASE WHEN routine.prokind='p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,routine.signature,application_roles);
  END IF;
  EXECUTE format('REVOKE EXECUTE ON %s %s FROM PUBLIC',CASE WHEN routine.prokind='p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,routine.signature);
 END LOOP;
END
$boundary$;

-- New source routines must declare their intended application callers explicitly.
-- This does not alter existing direct grants, including the workforce resolver.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
