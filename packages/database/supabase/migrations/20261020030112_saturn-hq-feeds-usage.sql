-- Saturn fork: USAGE on schema public for HQ's API role, completing the read
-- contract of 20261019070224_saturn-hq-feeds.sql (HQ plans 0012 Step 5 and 0017).
--
-- HQ's feed functions hq.carbon_sales_orders(), hq.carbon_purchase_orders() and
-- hq.carbon_jobs() are SECURITY INVOKER and name Carbon's tables in public, so
-- Postgres checks USAGE on public for hq_api before any column grant or row
-- policy applies. On a database where PUBLIC holds no USAGE on public (it was
-- revoked, so only named roles such as anon, authenticated, service_role and
-- postgres hold it), every feed call failed with "permission denied for schema
-- public": the first migration relied on PUBLIC's USAGE without granting it.
--
-- USAGE only lets hq_api name public's objects. What it can read stays the
-- 21 money-free columns and the two FOR SELECT policies per table of the first
-- migration; every other table, column and write is still refused. USAGE also
-- lets hq_api call the functions in public that grant EXECUTE to PUBLIC, which
-- is the surface anon already has through the API; hq_api sends no JWT claims,
-- so those answer for no user.
--
-- Guarded exactly like the first migration: it acts only where HQ's roles hq_api
-- and hq_owner, HQ's authz functions and the six feed tables exist, so Carbon's
-- own local and CI stacks migrate as before. HQ's deploy/data/tenants.sql
-- carries the same grant in its copy of the block. Idempotent.

DO $hq_feeds_usage$
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

  GRANT USAGE ON SCHEMA public TO hq_api;
END
$hq_feeds_usage$;
