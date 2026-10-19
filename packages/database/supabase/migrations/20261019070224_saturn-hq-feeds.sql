-- Saturn fork: Carbon's read contract for HQ's FEEDS canvas (HQ plans 0012 Step 5,
-- 0014 and 0017).
--
-- HQ shows each person counts of Carbon's open sales orders, open purchase orders
-- and active jobs. Its API role hq_api reads them live, in this database, through
-- HQ's own views hq.carbon_sales_orders, hq.carbon_purchase_orders and
-- hq.carbon_jobs. Those views are security_invoker, so the grants and row policies
-- below, on Carbon's tables, decide what hq_api can see. HQ never copies a row.
--
-- 1. Columns. hq_api may SELECT exactly these columns, holds no other privilege on
--    these tables, and nothing on any other Carbon table. None of them is money:
--      "salesOrder"         id, "companyId", "salesOrderId", status
--      "salesOrderLine"     "salesOrderId", "companyId", "promisedDate"
--      "purchaseOrder"      id, "companyId", "purchaseOrderId", status
--      "purchaseOrderLine"  "purchaseOrderId", "companyId", "promisedDate", "requiredDate"
--      job                  "companyId", "jobId", status, "dueDate"
--      company              id, name
--    The block refuses to finish if hq_api could read a column whose name contains
--    price, cost, rate, total, currency, tax or amount.
--
-- 2. Rows. hq_api sets the person as the transaction's authz.subject
--    ('user:<HQ sub>'). A row is visible when HQ's authz service gives that person
--    `view` on one of these Carbon modules in the row's company, which is how
--    Carbon's own SELECT policies (or a stricter rule) treat the same person:
--      "salesOrder"         sales, inventory or invoicing  (as Carbon)
--      "salesOrderLine"     sales                          (as Carbon)
--      "purchaseOrder"      purchasing, inventory or invoicing (as Carbon)
--      "purchaseOrderLine"  purchasing                     (as Carbon)
--      job                  production   (stricter: Carbon shows jobs to every employee)
--      company              any of those five
--    Each table gets two SELECT policies TO hq_api with the same test: a permissive
--    one (hq_api_feed) that admits those rows, and a restrictive one
--    (hq_api_feed_only) that admits nothing else. Carbon's own SELECT policies
--    apply TO PUBLIC and read request.jwt.claims, which any session may set, so
--    without the restrictive policy hq_api could reach rows through them.
--    The test is authz.covers((SELECT authz.scope(...)), resource): the person's
--    patterns are computed once per statement and matched per row in memory.
--    With authz.subject unset, every test is false and hq_api sees no row.
--
-- 3. Carbon's own SELECT policies on these tables apply TO PUBLIC, so Postgres
--    evaluates them for hq_api too, and a query fails unless hq_api may EXECUTE the
--    helpers they call: get_companies_with_employee_permission(text),
--    get_companies_with_employee_role() and get_company_groups_for_employee().
--    hq_api gets EXECUTE on exactly those three. They are read-only SECURITY
--    DEFINER functions that answer for the JWT in request.jwt.claims; hq_api sends
--    none, so they return no company, and the restrictive policy makes their answer
--    irrelevant to what hq_api sees.
--
-- 4. HQ's view owner. hq_owner (NOLOGIN; HQ's migrations run as it) gets USAGE on
--    schema public, which it needs to create the views. It gets no table grant.
--
-- Nothing here changes what Carbon's own roles (anon, authenticated,
-- service_role, postgres) can see or do: every grant and policy names hq_api or
-- hq_owner only: SELECT on columns, FOR SELECT policies, EXECUTE on three
-- read-only helpers and USAGE on public.
--
-- Guarded. Everything runs only where HQ's roles hq_api and hq_owner and HQ's
-- authz functions authz.current_subject(), authz.scope(text, text, text) and
-- authz.covers(text[], text) exist (HQ's shared database). Carbon's own local and
-- CI stacks have none of them and migrate as before. HQ's
-- deploy/data/tenants.sql carries this block verbatim for databases where those
-- roles or functions appear after this migration ran. Idempotent: running it
-- again changes nothing.

DO $hq_feeds$
DECLARE
  feed RECORD;
  helper RECORD;
  test TEXT;
  money TEXT;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hq_api')
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hq_owner')
    OR pg_catalog.to_regprocedure('authz.current_subject()') IS NULL
    OR pg_catalog.to_regprocedure('authz.scope(text,text,text)') IS NULL
    OR pg_catalog.to_regprocedure('authz.covers(text[],text)') IS NULL
    OR pg_catalog.to_regclass('public."salesOrder"') IS NULL
    OR pg_catalog.to_regclass('public."salesOrderLine"') IS NULL
    OR pg_catalog.to_regclass('public."purchaseOrder"') IS NULL
    OR pg_catalog.to_regclass('public."purchaseOrderLine"') IS NULL
    OR pg_catalog.to_regclass('public.job') IS NULL
    OR pg_catalog.to_regclass('public.company') IS NULL
  THEN
    RETURN;
  END IF;

  GRANT USAGE ON SCHEMA public TO hq_owner;
  FOR helper IN
    SELECT pg_catalog.to_regprocedure(h) AS fn
      FROM pg_catalog.unnest(ARRAY[
             'public.get_companies_with_employee_permission(text)',
             'public.get_companies_with_employee_role()',
             'public.get_company_groups_for_employee()']) AS h
  LOOP
    CONTINUE WHEN helper.fn IS NULL;
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO hq_api', helper.fn);
  END LOOP;

  FOR feed IN
    SELECT * FROM (VALUES
      ('salesOrder',
       ARRAY['id', 'companyId', 'salesOrderId', 'status'],
       'companyId', ARRAY['sales', 'inventory', 'invoicing']),
      ('salesOrderLine',
       ARRAY['salesOrderId', 'companyId', 'promisedDate'],
       'companyId', ARRAY['sales']),
      ('purchaseOrder',
       ARRAY['id', 'companyId', 'purchaseOrderId', 'status'],
       'companyId', ARRAY['purchasing', 'inventory', 'invoicing']),
      ('purchaseOrderLine',
       ARRAY['purchaseOrderId', 'companyId', 'promisedDate', 'requiredDate'],
       'companyId', ARRAY['purchasing']),
      ('job',
       ARRAY['companyId', 'jobId', 'status', 'dueDate'],
       'companyId', ARRAY['production']),
      ('company',
       ARRAY['id', 'name'],
       'id', ARRAY['sales', 'purchasing', 'inventory', 'invoicing', 'production'])
    ) AS t (name, columns, company_column, modules)
  LOOP
    -- Exactly these columns: REVOKE ALL on a table also revokes its column grants.
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM hq_api', feed.name);
    EXECUTE pg_catalog.format(
      'GRANT SELECT (%s) ON TABLE public.%I TO hq_api',
      (SELECT pg_catalog.string_agg(pg_catalog.format('%I', c), ', ' ORDER BY o)
         FROM pg_catalog.unnest(feed.columns) WITH ORDINALITY AS x (c, o)),
      feed.name);

    -- view on carbon:module.<module>:<companyId>, for any of the table's modules.
    test := (
      SELECT pg_catalog.string_agg(pg_catalog.format(
               'authz.covers((SELECT authz.scope(authz.current_subject(), %L, %L)), %L || %I)',
               'view', 'carbon:', 'carbon:module.' || m || ':', feed.company_column),
             ' OR ' ORDER BY o)
        FROM pg_catalog.unnest(feed.modules) WITH ORDINALITY AS x (m, o));
    IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_policy
       WHERE polrelid = pg_catalog.format('public.%I', feed.name)::regclass
         AND polname = 'hq_api_feed'
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE POLICY hq_api_feed ON public.%I AS PERMISSIVE FOR SELECT TO hq_api USING (%s)',
        feed.name, test);
    END IF;
    IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_policy
       WHERE polrelid = pg_catalog.format('public.%I', feed.name)::regclass
         AND polname = 'hq_api_feed_only'
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE POLICY hq_api_feed_only ON public.%I AS RESTRICTIVE FOR SELECT TO hq_api'
        ' USING (%s)',
        feed.name, test);
    END IF;
  END LOOP;

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
$hq_feeds$;
