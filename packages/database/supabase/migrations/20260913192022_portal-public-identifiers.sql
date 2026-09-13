-- Forward-only product rename. Historical migrations and ledger checksums stay
-- immutable. ALTER preserves object identity, data, ownership, grants and RLS.
-- The private runner creates its historical enrollment bridge transactionally;
-- ordinary Carbon migration/type generation never exposes a legacy RPC alias.
DO $rename$
DECLARE object record; target text; owners text[] := '{}'; owner_name text;
BEGIN
  FOR object IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname IN ('knowledgeCommandReceipt','knowledgeProcurementSchedule','knowledgeSourceOutbox')
  LOOP
    target := replace(object.relname,'knowledge','portal');
    IF to_regclass(format('public.%I',target)) IS NOT NULL THEN
      RAISE EXCEPTION 'Both legacy and Portal tables exist: %',target;
    END IF;
    EXECUTE format('ALTER TABLE public.%I RENAME TO %I',object.relname,target);
  END LOOP;

  FOR object IN SELECT p.oid,p.proname,pg_get_userbyid(p.proowner) AS owner,
      pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('knowledge_resolve_workforce_identity','knowledge_propagate_identity_revocation','knowledge_source_outbox_enqueue')
  LOOP
    IF NOT pg_has_role(current_user,object.owner,'MEMBER') THEN
      EXECUTE format('GRANT %I TO %I',object.owner,current_user);
      owners := array_append(owners,object.owner);
    END IF;
    target := replace(object.proname,'knowledge','portal');
    EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I',object.proname,object.arguments,target);
    -- Rewrite renamed public tables now, but retain legacy private-schema
    -- references until its atomic cutover. Workforce revocation must keep
    -- updating existing bindings between the two deployment migration streams.
    EXECUTE replace(replace(replace(pg_get_functiondef(object.oid),
      'knowledgeCommandReceipt','portalCommandReceipt'),
      'knowledgeProcurementSchedule','portalProcurementSchedule'),
      'knowledgeSourceOutbox','portalSourceOutbox');
  END LOOP;

  FOR object IN SELECT c.oid,c.relname,con.conname FROM pg_constraint con
    JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('portalCommandReceipt','portalProcurementSchedule','portalSourceOutbox')
      AND con.conname LIKE '%knowledge%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',object.relname,object.conname,replace(object.conname,'knowledge','portal'));
  END LOOP;
  FOR object IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='i' AND c.relname LIKE 'knowledge%'
  LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I',object.relname,replace(object.relname,'knowledge','portal'));
  END LOOP;
  FOR object IN SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname LIKE 'knowledge_%'
  LOOP
    EXECUTE format('ALTER TRIGGER %I ON public.%I RENAME TO %I',object.tgname,object.relname,replace(object.tgname,'knowledge','portal'));
  END LOOP;
  FOR object IN SELECT c.relname,p.polname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname IN ('portalCommandReceipt','portalProcurementSchedule','portalSourceOutbox') AND p.polname LIKE '%knowledge%'
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.%I RENAME TO %I',object.polname,object.relname,replace(object.polname,'knowledge','portal'));
  END LOOP;
  FOREACH owner_name IN ARRAY owners LOOP
    EXECUTE format('REVOKE %I FROM %I',owner_name,current_user);
  END LOOP;
END $rename$;
