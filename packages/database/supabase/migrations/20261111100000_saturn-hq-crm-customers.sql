-- Saturn fork: Carbon's customers for HQ's CRM (HQ plan 0022 §9.3, step A6).
--
-- HQ's CRM links each of its accounts to Carbon's customer once the buyer exists
-- in the ERP. Its API role hq_api lists Carbon's customers, live, in this
-- database, through HQ's own function hq.carbon_customers() (SECURITY INVOKER, a
-- string body: no dependency on these columns), so the grants and row policies
-- below, on Carbon's table, decide what hq_api can see. HQ never copies a row.
--
-- 1. Columns. hq_api may SELECT exactly customer.id, customer."companyId" and
--    customer.name, holds no other privilege on the table, and gains nothing on
--    any other Carbon table. None of them is money; the block refuses to finish
--    if hq_api could read a column in public named like money.
-- 2. Rows. A customer is visible when HQ's authz service gives the person in the
--    transaction's authz.subject ('user:<HQ sub>') `view` on
--    carbon:module.sales:<companyId>, as Carbon's own SELECT policy treats an
--    employee with sales_view. Two SELECT policies TO hq_api carry that test: a
--    permissive one (hq_api_feed) that admits those rows and a restrictive one
--    (hq_api_feed_only) that admits nothing else, because Carbon's own SELECT
--    policy applies TO PUBLIC and reads request.jwt.claims, which any session can
--    set. With authz.subject unset, hq_api sees no customer.
-- 3. Carbon's SELECT policy on customer calls get_companies_with_employee_permission
--    (text) and get_customer_ids_with_customer_permission(text), so hq_api gets
--    EXECUTE on both (the first is already granted by 20261019070224). They are
--    read-only SECURITY DEFINER functions answering for request.jwt.claims; hq_api
--    sends none, so they return nothing, and the restrictive policy makes their
--    answer irrelevant.
-- 4. hq_owner (HQ's function owner) and hq_api keep the USAGE on public that
--    20261019070224 and 20261020030112 grant; granting it again is a no-op.
--
-- Nothing here changes what Carbon's own roles (anon, authenticated,
-- service_role, postgres) can see or do. Guarded: it runs only where HQ's roles,
-- HQ's authz functions and public.customer exist (HQ's shared database); Carbon's
-- own local and CI stacks migrate as before. HQ's deploy/data/tenants.sql carries
-- this block verbatim (section 10). Idempotent.

DO $hq_crm_customers$
DECLARE
  helper RECORD;
  test TEXT;
  money TEXT;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hq_api')
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hq_owner')
    OR pg_catalog.to_regprocedure('authz.current_subject()') IS NULL
    OR pg_catalog.to_regprocedure('authz.scope(text,text,text)') IS NULL
    OR pg_catalog.to_regprocedure('authz.covers(text[],text)') IS NULL
    OR pg_catalog.to_regclass('public.customer') IS NULL
  THEN
    RETURN;
  END IF;

  GRANT USAGE ON SCHEMA public TO hq_owner;
  GRANT USAGE ON SCHEMA public TO hq_api;
  FOR helper IN
    SELECT pg_catalog.to_regprocedure(h) AS fn
      FROM pg_catalog.unnest(ARRAY[
             'public.get_companies_with_employee_permission(text)',
             'public.get_customer_ids_with_customer_permission(text)']) AS h
  LOOP
    CONTINUE WHEN helper.fn IS NULL;
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO hq_api', helper.fn);
  END LOOP;

  -- Exactly these columns: REVOKE ALL on a table also revokes its column grants.
  REVOKE ALL ON TABLE public.customer FROM hq_api;
  GRANT SELECT (id, "companyId", name) ON TABLE public.customer TO hq_api;

  -- view on carbon:module.sales:<companyId>.
  test := pg_catalog.format(
    'authz.covers((SELECT authz.scope(authz.current_subject(), %L, %L)), %L || %I)',
    'view', 'carbon:', 'carbon:module.sales:', 'companyId');
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_policy
     WHERE polrelid = 'public.customer'::regclass AND polname = 'hq_api_feed'
  ) THEN
    EXECUTE pg_catalog.format(
      'CREATE POLICY hq_api_feed ON public.customer AS PERMISSIVE FOR SELECT TO hq_api'
      ' USING (%s)', test);
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_policy
     WHERE polrelid = 'public.customer'::regclass AND polname = 'hq_api_feed_only'
  ) THEN
    EXECUTE pg_catalog.format(
      'CREATE POLICY hq_api_feed_only ON public.customer AS RESTRICTIVE FOR SELECT TO hq_api'
      ' USING (%s)', test);
  END IF;

  -- No money, ever: no column hq_api can read in public may be named like one.
  SELECT pg_catalog.string_agg(pg_catalog.format('%I.%I', c.relname, a.attname), ', ')
    INTO money
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_catalog.pg_attribute AS a
      ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND a.attname ~* '(price|cost|rate|total|currency|tax|amount)'
     AND pg_catalog.has_column_privilege('hq_api', c.oid, a.attnum, 'SELECT');
  IF money IS NOT NULL THEN
    RAISE EXCEPTION 'hq_api must not read a money column: %', money;
  END IF;
END
$hq_crm_customers$;
