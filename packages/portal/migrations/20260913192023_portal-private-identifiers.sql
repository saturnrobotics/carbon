-- Forward-only rename following verbatim historical replay. ALTER preserves OIDs,
-- rows, ACLs and the original migration checksums. Stored SQL requires rewriting.
RESET ROLE;
DO $rename$
DECLARE object record; old_name text; target text; definition text; clause text;
  temporary_memberships text[] := '{}'; schema_create boolean;
BEGIN
  IF to_regprocedure('public.portal_resolve_workforce_identity(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Apply the Carbon Portal public-identifiers migration before private Portal migrations';
  END IF;
  FOREACH old_name IN ARRAY ARRAY['knowledge','knowledge_metering','knowledge_migrations'] LOOP
    target := replace(old_name,'knowledge','portal');
    IF to_regnamespace(old_name) IS NOT NULL AND to_regnamespace(target) IS NOT NULL THEN
      RAISE EXCEPTION 'Both legacy and Portal namespaces exist: %',target;
    END IF;
  END LOOP;
  FOREACH old_name IN ARRAY ARRAY['knowledge_read','knowledge_ingest','knowledge_review','knowledge_actions','knowledge_migrate','knowledge_maintenance','knowledge_retention_owner','knowledge_enrollment_owner'] LOOP
    target := replace(old_name,'knowledge','portal');
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=old_name) THEN
      IF EXISTS(SELECT FROM pg_roles WHERE rolname=target) THEN
        RAISE EXCEPTION 'Both legacy and Portal policy roles exist: %',target;
      END IF;
      IF EXISTS(SELECT FROM pg_roles WHERE rolname=old_name AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
        RAISE EXCEPTION 'Unsafe legacy policy role: %',old_name;
      END IF;
      EXECUTE format('ALTER ROLE %I RENAME TO %I',old_name,target);
    END IF;
  END LOOP;
  FOREACH old_name IN ARRAY ARRAY['knowledge','knowledge_metering','knowledge_migrations'] LOOP
    IF to_regnamespace(old_name) IS NOT NULL THEN
      EXECUTE format('ALTER SCHEMA %I RENAME TO %I',old_name,replace(old_name,'knowledge','portal'));
    END IF;
  END LOOP;

  FOR object IN SELECT p.oid,n.nspname,pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prokind='f' AND (n.nspname IN ('portal','portal_metering')
      OR (n.nspname='public' AND p.proname IN ('portal_resolve_workforce_identity','portal_propagate_identity_revocation','portal_source_outbox_enqueue')))
  LOOP
    definition := replace(pg_get_functiondef(object.oid),'knowledge','portal');
    IF NOT pg_has_role(session_user,object.owner,'MEMBER') THEN
      EXECUTE format('GRANT %I TO %I',object.owner,session_user);
      temporary_memberships := array_append(temporary_memberships,object.owner);
    END IF;
    schema_create := has_schema_privilege(object.owner,object.nspname,'CREATE');
    IF NOT schema_create THEN
      EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I',object.nspname,object.owner);
    END IF;
    EXECUTE format('SET LOCAL ROLE %I',object.owner);
    EXECUTE definition;
    RESET ROLE;
    IF NOT schema_create THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I',object.nspname,object.owner);
    END IF;
  END LOOP;

  FOR object IN SELECT n.nspname,c.relname,p.polname,
      pg_get_expr(p.polqual,p.polrelid) AS using_expression,
      pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('portal','portal_metering')
  LOOP
    clause := '';
    IF object.using_expression IS NOT NULL THEN
      clause := clause || ' USING (' || replace(object.using_expression,'knowledge','portal') || ')';
    END IF;
    IF object.check_expression IS NOT NULL THEN
      clause := clause || ' WITH CHECK (' || replace(object.check_expression,'knowledge','portal') || ')';
    END IF;
    IF clause <> '' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I%s',object.polname,object.nspname,object.relname,clause);
    END IF;
  END LOOP;

  -- Preserve durable admission and idempotency state under new operation names.
  ALTER TABLE portal_metering."requestPolicy" DROP CONSTRAINT "requestPolicy_endpoint_check";
  FOREACH old_name IN ARRAY ARRAY['policy','reservation','requestPolicy','requestWindow'] LOOP
    EXECUTE format('UPDATE portal_metering.%I SET endpoint=regexp_replace(endpoint,%L,%L) WHERE endpoint LIKE %L',old_name,'^knowledge[.]','portal.','knowledge.%');
  END LOOP;
  ALTER TABLE portal_metering."requestPolicy" ADD CONSTRAINT "requestPolicy_endpoint_check" CHECK(endpoint IN ('portal.query','portal.entity'));

  -- Retain FORCE RLS: use the existing enrollment owner and invalidate caches.
  IF NOT pg_has_role(session_user,'portal_enrollment_owner','MEMBER') THEN
    EXECUTE format('GRANT portal_enrollment_owner TO %I',session_user);
    temporary_memberships := array_append(temporary_memberships,'portal_enrollment_owner');
  END IF;
  SET LOCAL ROLE portal_enrollment_owner;
  UPDATE portal."identityBinding" b SET capabilities=ARRAY(
    SELECT regexp_replace(capability,'^knowledge[.]','portal.') FROM unnest(b.capabilities) AS capability
  ), version=version+1 WHERE EXISTS(SELECT FROM unnest(b.capabilities) AS capability WHERE capability LIKE 'knowledge.%');
  RESET ROLE;

  FOR object IN SELECT n.nspname,c.relname,t.tgname FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('portal','portal_metering') AND NOT t.tgisinternal AND t.tgname LIKE 'knowledge_%'
  LOOP
    EXECUTE format('ALTER TRIGGER %I ON %I.%I RENAME TO %I',object.tgname,object.nspname,object.relname,replace(object.tgname,'knowledge','portal'));
  END LOOP;
  FOR object IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('portal','portal_metering') AND c.relkind='i' AND c.relname LIKE 'knowledge%'
  LOOP
    EXECUTE format('ALTER INDEX %I.%I RENAME TO %I',object.nspname,object.relname,replace(object.relname,'knowledge','portal'));
  END LOOP;
  FOREACH old_name IN ARRAY temporary_memberships LOOP
    EXECUTE format('REVOKE %I FROM %I',old_name,session_user);
  END LOOP;
END $rename$;
-- Historical enrollment grants target the temporary bridge on a fresh install.
-- Carry that exact execute capability onto the renamed source-owned resolver.
GRANT EXECUTE ON FUNCTION public.portal_resolve_workforce_identity(text,text,text) TO portal_enrollment_owner;
DROP FUNCTION IF EXISTS public.knowledge_resolve_workforce_identity(text,text,text);
