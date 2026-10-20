-- Regression test for 20261019070224_saturn-hq-feeds.sql and its follow-up
-- 20261020030112_saturn-hq-feeds-usage.sql (HQ plan 0012 Step 5): the guard, the
-- money-free column grants to hq_api, its USAGE on public, the row policies TO
-- hq_api, and that Carbon's own roles see exactly what they saw before.
--
-- Run against a local database migrated to head, as a superuser, on a database
-- without HQ's roles and schema authz (both are stubbed below), for example:
--   psql "postgresql://supabase_admin:postgres@localhost:$PORT_DB/postgres" -X \
--     -v ON_ERROR_STOP=1 -f packages/database/supabase/tests/saturn-hq-feeds.test.sql
-- The migrations are idempotent, so the test runs them again with \ir once each
-- stand-in exists. Everything runs in one transaction that is rolled back;
-- nothing persists.
BEGIN;
SET LOCAL search_path = public;

-- Schema public as on a database where PUBLIC holds no USAGE there and only
-- named roles do. Carbon's local stack still grants it to PUBLIC, which hid that
-- the first migration never granted hq_api USAGE: on such a database every HQ
-- read failed with "permission denied for schema public".
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  ASSERT has_schema_privilege('anon', 'public', 'USAGE')
    AND has_schema_privilege('authenticated', 'public', 'USAGE')
    AND has_schema_privilege('service_role', 'public', 'USAGE'),
    'Carbon''s API roles hold USAGE on public by name, not through PUBLIC';
END $$;

-- Helpers. Each runs one query in this transaction as one role, with HQ's
-- authz.subject and (optionally) Carbon's request.jwt.claims set, and returns its
-- first column as a sorted array.
CREATE FUNCTION pg_temp.ids(p_role TEXT, p_subject TEXT, p_query TEXT, p_claims TEXT DEFAULT '')
RETURNS TEXT[]
LANGUAGE plpgsql AS $$
DECLARE
  v_result TEXT[];
BEGIN
  PERFORM set_config('authz.subject', coalesce(p_subject, ''), true);
  PERFORM set_config('request.jwt.claims', p_claims, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE format('SELECT coalesce(array_agg(x::TEXT ORDER BY x::TEXT), ''{}'') FROM (%s) AS q (x)',
                 p_query)
    INTO v_result;
  RESET ROLE;
  PERFORM set_config('authz.subject', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_result;
END $$;

-- Returns the permission error's message.
CREATE FUNCTION pg_temp.expect_denied(p_role TEXT, p_statement TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_statement;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RETURN SQLERRM;
  END;
  RAISE EXCEPTION 'expected permission denied as %, but it ran: %', p_role, p_statement;
END $$;

CREATE FUNCTION pg_temp.feed_state() RETURNS TEXT
LANGUAGE sql AS $$
  SELECT concat_ws(' | ',
    (SELECT string_agg(x, ', ' ORDER BY x)
       FROM (SELECT p.polrelid::REGCLASS::TEXT || '.' || p.polname || '=' ||
                    pg_get_expr(p.polqual, p.polrelid) AS x
               FROM pg_policy AS p WHERE p.polname LIKE 'hq\_api\_feed%') AS policies),
    (SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname)
       FROM pg_class AS c
       JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::REGNAMESPACE
        AND EXISTS (SELECT FROM pg_roles WHERE rolname = 'hq_api')
        AND has_column_privilege('hq_api', c.oid, a.attnum, 'SELECT')),
    (SELECT string_agg(a.grantee::REGROLE::TEXT || '=' || a.privilege_type, ', '
                       ORDER BY a.grantee::REGROLE::TEXT, a.privilege_type)
       FROM pg_namespace AS n, aclexplode(n.nspacl) AS a
      WHERE n.nspname = 'public'
        AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('hq_api', 'hq_owner'))))
$$;

-- 1. The guard: on Carbon's own stack the migration did nothing --------------------

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('hq_api', 'hq_owner'))
    OR to_regnamespace('authz') IS NOT NULL
  THEN
    RAISE EXCEPTION 'run this test on Carbon''s own database: HQ''s roles or schema authz exist';
  END IF;
  ASSERT NOT EXISTS (SELECT FROM pg_policy WHERE polname LIKE 'hq\_api\_feed%'),
    'no feed policy without HQ';
END $$;

-- HQ's roles alone (no authz functions): still nothing.
CREATE ROLE hq_api NOLOGIN NOINHERIT;
CREATE ROLE hq_owner NOLOGIN NOINHERIT;
\ir ../migrations/20261019070224_saturn-hq-feeds.sql
\ir ../migrations/20261020030112_saturn-hq-feeds-usage.sql
DO $$
BEGIN
  ASSERT pg_temp.feed_state() = '', 'roles without authz: no grant and no policy';
  ASSERT NOT EXISTS (
    SELECT FROM pg_namespace AS n, aclexplode(n.nspacl) AS a
     WHERE n.nspname = 'public' AND a.grantee IN ('hq_owner'::REGROLE, 'hq_api'::REGROLE)
  ), 'roles without authz: no USAGE granted to hq_owner or hq_api';
  ASSERT NOT EXISTS (
    SELECT FROM pg_proc AS p, aclexplode(p.proacl) AS a
     WHERE p.pronamespace = 'public'::REGNAMESPACE AND a.grantee = 'hq_api'::REGROLE
  ), 'roles without authz: no EXECUTE granted to hq_api';
END $$;

-- HQ's authz, stubbed with plan 0006B B4's signatures: current_subject and scope
-- are SECURITY DEFINER readers of a test table, covers is the real expression.
CREATE SCHEMA authz;
CREATE TABLE authz.test_grant (subject TEXT, action TEXT, pattern TEXT);
CREATE FUNCTION authz.current_subject() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT nullif(pg_catalog.current_setting('authz.subject', true), '') $$;
CREATE FUNCTION authz.scope(subject TEXT, action TEXT, prefix TEXT) RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.array_agg(DISTINCT g.pattern ORDER BY g.pattern), '{}')
    FROM authz.test_grant AS g
   WHERE g.subject = scope.subject AND g.action = scope.action
     AND scope.prefix <> '' AND pg_catalog.starts_with(g.pattern, scope.prefix)
$$;
CREATE FUNCTION authz.covers(patterns TEXT[], resource TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $$
  SELECT coalesce(bool_or(
           x.p_ns = x.r_ns AND x.p_type <> '' AND x.p_rest = '' AND x.r_type <> ''
           AND x.r_rest = ''
           AND (x.p_type = x.r_type
                OR (pg_catalog.right(x.p_type, 2) = '.*'
                    AND pg_catalog.starts_with(x.r_type, pg_catalog.left(x.p_type, -1))))
           AND (x.p_id IN ('', '*') OR x.p_id = x.r_id)
         ), false)
    FROM (SELECT pg_catalog.split_part(p, ':', 1) AS p_ns,
                 pg_catalog.split_part(p, ':', 2) AS p_type,
                 pg_catalog.split_part(p, ':', 3) AS p_id,
                 pg_catalog.split_part(p, ':', 4) AS p_rest,
                 pg_catalog.split_part(covers.resource, ':', 1) AS r_ns,
                 pg_catalog.split_part(covers.resource, ':', 2) AS r_type,
                 pg_catalog.split_part(covers.resource, ':', 3) AS r_id,
                 pg_catalog.split_part(covers.resource, ':', 4) AS r_rest
            FROM pg_catalog.unnest(covers.patterns) AS p) AS x
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authz FROM PUBLIC;
GRANT USAGE ON SCHEMA authz TO hq_api;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO hq_api;

-- With HQ's roles and authz present, the first migration alone grants the
-- columns and creates the policies but gives hq_api no USAGE on public, so every
-- read as hq_api fails before a grant or policy is consulted.
\ir ../migrations/20261019070224_saturn-hq-feeds.sql
DO $$
DECLARE
  t TEXT;
BEGIN
  ASSERT NOT has_schema_privilege('hq_api', 'public', 'USAGE'),
    'first migration alone: hq_api lacks USAGE on public';
  FOREACH t IN ARRAY ARRAY['"salesOrder"', '"salesOrderLine"', '"purchaseOrder"',
                           '"purchaseOrderLine"', 'job', 'company']
  LOOP
    ASSERT pg_temp.expect_denied('hq_api', format('SELECT 1 FROM public.%s', t))
      = 'permission denied for schema public', format('first migration alone: %s denied', t);
  END LOOP;
END $$;

-- The follow-up grants it; running both again changes nothing.
\ir ../migrations/20261020030112_saturn-hq-feeds-usage.sql
DO $$ BEGIN PERFORM set_config('test.feed_state', pg_temp.feed_state(), true); END $$;
\ir ../migrations/20261019070224_saturn-hq-feeds.sql
\ir ../migrations/20261020030112_saturn-hq-feeds-usage.sql
DO $$
BEGIN
  ASSERT pg_temp.feed_state() = current_setting('test.feed_state'), 'the blocks are idempotent';
  ASSERT (SELECT count(*) FROM pg_policy WHERE polname LIKE 'hq\_api\_feed%') = 12,
    'two policies on each of six tables';
  ASSERT split_part(pg_temp.feed_state(), ' | ', 3) = 'hq_api=USAGE, hq_owner=USAGE',
    'hq_api and hq_owner hold exactly USAGE on public, by their own grants';
END $$;

-- 2. Fixture -----------------------------------------------------------------------

-- Two companies in one group; open and closed sales orders, purchase orders and
-- jobs; a Carbon user with sales_view in both companies. Foreign keys and Carbon's
-- triggers are off while it is written (replica mode), so only the columns the
-- feeds read need values. The authz grants are stub rows.
DO $fixture$
DECLARE
  co_a TEXT;
  co_b TEXT;
  actor TEXT := gen_random_uuid()::TEXT;
  today DATE := (now() AT TIME ZONE 'UTC')::DATE;
BEGIN
  INSERT INTO public."user" (id, email) VALUES (actor, actor || '@example.com');
  INSERT INTO public.company (name, "baseCurrencyCode")
  VALUES ('HQ Feeds Fixture A', 'USD') RETURNING id INTO co_a;
  INSERT INTO public.company (name, "baseCurrencyCode")
  VALUES ('HQ Feeds Fixture B', 'USD') RETURNING id INTO co_b;
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.company SET "companyGroupId" = 'hq-feeds-group' WHERE id IN (co_a, co_b);
  INSERT INTO public."salesOrder"
    (id, "companyId", "salesOrderId", status, "customerId", "currencyCode", "exchangeRate",
     "createdBy")
  VALUES
    ('hqf-so1', co_a, 'SO-HQF-1', 'Confirmed', 'hqf-cu', 'USD', 1.25, actor),
    ('hqf-so2', co_b, 'SO-HQF-2', 'To Ship', 'hqf-cu', 'USD', 1, actor),
    ('hqf-so3', co_a, 'SO-HQF-3', 'Completed', 'hqf-cu', 'USD', 1, actor);
  INSERT INTO public."salesOrderLine"
    (id, "companyId", "salesOrderId", "salesOrderLineType", description, "promisedDate",
     "unitPrice", "createdBy")
  VALUES
    ('hqf-sol1', co_a, 'hqf-so1', 'Comment', 'HQ feeds fixture', today - 3, 125.5, actor),
    ('hqf-sol2', co_b, 'hqf-so2', 'Comment', 'HQ feeds fixture', today + 2, 99, actor);
  INSERT INTO public."purchaseOrder"
    (id, "companyId", "purchaseOrderId", status, "supplierId", "supplierInteractionId",
     "createdBy")
  VALUES
    ('hqf-po1', co_a, 'PO-HQF-1', 'To Receive', 'hqf-su', 'hqf-si', actor),
    ('hqf-po2', co_b, 'PO-HQF-2', 'Closed', 'hqf-su', 'hqf-si', actor);
  INSERT INTO public."purchaseOrderLine"
    (id, "companyId", "purchaseOrderId", "purchaseOrderLineType", description, "requiredDate",
     "supplierUnitPrice", "createdBy")
  VALUES ('hqf-pol1', co_a, 'hqf-po1', 'Comment', 'HQ feeds fixture', today + 3, 7, actor);
  INSERT INTO public.job
    (id, "companyId", "jobId", status, "itemId", "unitOfMeasureCode", "locationId", "dueDate",
     "createdBy")
  VALUES
    ('hqf-j1', co_a, 'J-HQF-1', 'In Progress', 'hqf-it', 'EA', 'hqf-lo', today - 1, actor),
    ('hqf-j2', co_b, 'J-HQF-2', 'Ready', 'hqf-it', 'EA', 'hqf-lo', today + 4, actor);
  INSERT INTO public."userToCompany" ("userId", "companyId", role)
  VALUES (actor, co_a, 'employee'), (actor, co_b, 'employee');
  INSERT INTO public."userPermission" (id, permissions)
  VALUES (actor, jsonb_build_object('sales_view', jsonb_build_array(co_a, co_b)))
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions;
  PERFORM set_config('session_replication_role', 'origin', true);

  INSERT INTO authz.test_grant VALUES
    ('user:sales', 'view', 'carbon:module.sales:' || co_a),
    ('user:floor', 'view', 'carbon:module.production:' || co_a),
    ('user:floor', 'view', 'carbon:module.sales:' || co_b),
    ('user:floor', 'view', 'carbon:module.parts:' || co_b),
    ('user:stock', 'view', 'carbon:module.inventory:' || co_a),
    ('user:buyer', 'view', 'carbon:module.purchasing:' || co_a),
    ('user:books', 'view', 'carbon:module.invoicing:' || co_b),
    ('user:all-a', 'view', 'carbon:module.*:' || co_a),
    ('user:editor', 'update', 'carbon:module.sales:' || co_a);
  PERFORM set_config('test.co_a', co_a, true);
  PERFORM set_config('test.co_b', co_b, true);
  PERFORM set_config('test.actor', actor, true);
END $fixture$;

-- 3. Row filtering for hq_api ------------------------------------------------------

-- hq_api's own USAGE on public is load-bearing: without it (PUBLIC holds none
-- here) the read fails before any policy runs; with it, the policies filter rows.
DO $$
DECLARE
  so TEXT := 'SELECT "salesOrderId" FROM public."salesOrder" WHERE id LIKE ''hqf-%''';
BEGIN
  REVOKE USAGE ON SCHEMA public FROM hq_api;
  ASSERT pg_temp.expect_denied('hq_api', so) = 'permission denied for schema public',
    'no USAGE on public: the read fails';
  GRANT USAGE ON SCHEMA public TO hq_api;
  ASSERT pg_temp.ids('hq_api', 'user:sales', so) = '{SO-HQF-1,SO-HQF-3}',
    'USAGE on public: the rows authz allows';
  ASSERT pg_temp.ids('hq_api', 'user:nobody', so) = '{}', 'USAGE on public: no grant, no row';
END $$;

DO $$
DECLARE
  co_a TEXT := current_setting('test.co_a');
  co_b TEXT := current_setting('test.co_b');
  so TEXT := 'SELECT "salesOrderId" FROM public."salesOrder" WHERE id LIKE ''hqf-%''';
  sol TEXT := 'SELECT "salesOrderId" FROM public."salesOrderLine" WHERE "salesOrderId" LIKE ''hqf-%''';
  po TEXT := 'SELECT "purchaseOrderId" FROM public."purchaseOrder" WHERE id LIKE ''hqf-%''';
  pol TEXT := 'SELECT "purchaseOrderId" FROM public."purchaseOrderLine" WHERE "purchaseOrderId" LIKE ''hqf-%''';
  job TEXT := 'SELECT "jobId" FROM public.job WHERE "jobId" LIKE ''J-HQF-%''';
  co TEXT := format('SELECT name FROM public.company WHERE id IN (%L, %L)', co_a, co_b);
BEGIN
  -- Sales orders: sales, inventory or invoicing in the row's company, as Carbon.
  ASSERT pg_temp.ids('hq_api', 'user:sales', so) = '{SO-HQF-1,SO-HQF-3}', 'sales sees company A';
  ASSERT pg_temp.ids('hq_api', 'user:floor', so) = '{SO-HQF-2}', 'floor sees company B';
  ASSERT pg_temp.ids('hq_api', 'user:stock', so) = '{SO-HQF-1,SO-HQF-3}', 'inventory sees orders';
  ASSERT pg_temp.ids('hq_api', 'user:books', so) = '{SO-HQF-2}', 'invoicing sees orders';
  ASSERT pg_temp.ids('hq_api', 'user:buyer', so) = '{}', 'purchasing sees no sales order';
  -- Sales order lines: sales only, as Carbon.
  ASSERT pg_temp.ids('hq_api', 'user:sales', sol) = '{hqf-so1}', 'sales sees its lines';
  ASSERT pg_temp.ids('hq_api', 'user:stock', sol) = '{}', 'inventory sees no line';
  -- Purchase orders: purchasing, inventory or invoicing; lines: purchasing only.
  ASSERT pg_temp.ids('hq_api', 'user:buyer', po) = '{PO-HQF-1}', 'buyer sees company A';
  ASSERT pg_temp.ids('hq_api', 'user:stock', po) = '{PO-HQF-1}', 'inventory sees orders';
  ASSERT pg_temp.ids('hq_api', 'user:books', po) = '{PO-HQF-2}', 'invoicing sees orders';
  ASSERT pg_temp.ids('hq_api', 'user:sales', po) = '{}', 'sales sees no purchase order';
  ASSERT pg_temp.ids('hq_api', 'user:buyer', pol) = '{hqf-po1}', 'buyer sees its lines';
  ASSERT pg_temp.ids('hq_api', 'user:stock', pol) = '{}', 'inventory sees no line';
  -- Jobs: production only (stricter than Carbon, which shows jobs to every employee).
  ASSERT pg_temp.ids('hq_api', 'user:floor', job) = '{J-HQF-1}', 'floor sees company A jobs';
  ASSERT pg_temp.ids('hq_api', 'user:sales', job) = '{}', 'sales sees no job';
  -- Companies: through any of the five modules.
  ASSERT pg_temp.ids('hq_api', 'user:sales', co) = '{"HQ Feeds Fixture A"}', 'sales: company A';
  ASSERT pg_temp.ids('hq_api', 'user:floor', co)
    = '{"HQ Feeds Fixture A","HQ Feeds Fixture B"}', 'floor: both companies';
  ASSERT pg_temp.ids('hq_api', 'user:buyer', co) = '{"HQ Feeds Fixture A"}', 'buyer: company A';
  -- A module wildcard in one company covers every feed table there.
  ASSERT pg_temp.ids('hq_api', 'user:all-a', so) = '{SO-HQF-1,SO-HQF-3}', 'module.* sees orders';
  ASSERT pg_temp.ids('hq_api', 'user:all-a', job) = '{J-HQF-1}', 'module.* sees jobs';
  -- Fail closed: no subject, nobody, or another action than view.
  ASSERT pg_temp.ids('hq_api', NULL, so) = '{}', 'no authz.subject: no row';
  ASSERT pg_temp.ids('hq_api', 'user:nobody', so) = '{}', 'no grant: no row';
  ASSERT pg_temp.ids('hq_api', 'user:editor', so) = '{}', 'update is not view';
  ASSERT pg_temp.ids('hq_api', NULL, co) = '{}', 'no authz.subject: no company';
END $$;

-- 4. Carbon's own claims never widen hq_api ---------------------------------------

-- Carbon's SELECT policies apply TO PUBLIC and read request.jwt.claims, which any
-- session can set. The restrictive policy keeps hq_api to authz's answer.
DO $$
DECLARE
  forged TEXT := jsonb_build_object('sub', current_setting('test.actor'),
                                    'role', 'authenticated')::TEXT;
  so TEXT := 'SELECT "salesOrderId" FROM public."salesOrder" WHERE id LIKE ''hqf-%''';
BEGIN
  ASSERT pg_temp.ids('hq_api', 'user:nobody', so, forged) = '{}', 'forged claims: no row';
  ASSERT pg_temp.ids('hq_api', 'user:sales', so, forged) = '{SO-HQF-1,SO-HQF-3}',
    'forged claims add nothing to authz''s answer';
END $$;

-- 5. Money and writes stay out of reach -------------------------------------------

DO $$
DECLARE
  money TEXT[];
  extra TEXT[];
BEGIN
  SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attname) INTO money
    FROM pg_class AS c
    JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relnamespace = 'public'::REGNAMESPACE
     AND a.attname ~* '(price|cost|rate|total|currency|tax|amount)'
     AND has_column_privilege('hq_api', c.oid, a.attnum, 'SELECT');
  ASSERT money IS NULL, format('hq_api reads money columns: %s', money);

  SELECT array_agg(x ORDER BY x) INTO extra
    FROM unnest(string_to_array(split_part(pg_temp.feed_state(), ' | ', 2), ', ')) AS x
   WHERE x NOT IN (
     'company.id', 'company.name',
     'job.companyId', 'job.dueDate', 'job.jobId', 'job.status',
     'purchaseOrder.companyId', 'purchaseOrder.id', 'purchaseOrder.purchaseOrderId',
     'purchaseOrder.status',
     'purchaseOrderLine.companyId', 'purchaseOrderLine.promisedDate',
     'purchaseOrderLine.purchaseOrderId', 'purchaseOrderLine.requiredDate',
     'salesOrder.companyId', 'salesOrder.id', 'salesOrder.salesOrderId', 'salesOrder.status',
     'salesOrderLine.companyId', 'salesOrderLine.promisedDate', 'salesOrderLine.salesOrderId');
  ASSERT extra IS NULL, format('hq_api reads more than the feed columns: %s', extra);
  ASSERT array_length(string_to_array(split_part(pg_temp.feed_state(), ' | ', 2), ', '), 1) = 21,
    'hq_api reads exactly the 21 feed columns';

  ASSERT NOT EXISTS (
    SELECT FROM pg_class AS c,
           (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                   ('TRIGGER')) AS p (privilege)
     WHERE c.relnamespace = 'public'::REGNAMESPACE AND c.relkind IN ('r', 'p', 'v')
       AND (has_table_privilege('hq_api', c.oid, p.privilege)
            OR (p.privilege IN ('INSERT', 'UPDATE', 'REFERENCES')
                AND has_any_column_privilege('hq_api', c.oid, p.privilege)))
  ), 'hq_api holds nothing but SELECT in public';
  ASSERT has_function_privilege('hq_api',
    'public.get_companies_with_employee_permission(text)', 'EXECUTE')
    AND has_function_privilege('hq_api', 'public.get_companies_with_employee_role()', 'EXECUTE')
    AND has_function_privilege('hq_api', 'public.get_company_groups_for_employee()', 'EXECUTE'),
    'hq_api may run the helpers Carbon''s own SELECT policies call';
  ASSERT has_schema_privilege('hq_owner', 'public', 'USAGE'), 'hq_owner may name public';
  ASSERT has_schema_privilege('hq_api', 'public', 'USAGE')
    AND NOT has_schema_privilege('hq_api', 'public', 'CREATE'),
    'hq_api may name public and create nothing there';
  ASSERT NOT EXISTS (
    SELECT FROM pg_class AS c
     WHERE c.relnamespace = 'public'::REGNAMESPACE
       AND has_table_privilege('hq_owner', c.oid, 'SELECT')
  ), 'hq_owner holds no table';

  PERFORM pg_temp.expect_denied('hq_api', 'SELECT "unitPrice" FROM public."salesOrderLine"');
  PERFORM pg_temp.expect_denied('hq_api', 'SELECT "exchangeRate" FROM public."salesOrder"');
  PERFORM pg_temp.expect_denied('hq_api', 'SELECT "baseCurrencyCode" FROM public.company');
  PERFORM pg_temp.expect_denied('hq_api', 'SELECT * FROM public."purchaseOrderLine"');
  PERFORM pg_temp.expect_denied('hq_api', 'SELECT * FROM public."customer"');
  PERFORM pg_temp.expect_denied('hq_api', 'UPDATE public."salesOrder" SET status = ''Closed''');
  PERFORM pg_temp.expect_denied('hq_api', 'DELETE FROM public.job');
  PERFORM pg_temp.expect_denied('hq_api', 'CREATE TABLE public.hq_feeds_probe (id INT)');
END $$;

-- 6. Carbon's own roles are unchanged ---------------------------------------------

DO $$
DECLARE
  claims TEXT := jsonb_build_object('sub', current_setting('test.actor'),
                                    'role', 'authenticated')::TEXT;
  so TEXT := 'SELECT "salesOrderId" FROM public."salesOrder" WHERE id LIKE ''hqf-%''';
BEGIN
  ASSERT NOT EXISTS (
    SELECT FROM pg_policy
     WHERE polname LIKE 'hq\_api\_feed%'
       AND (polcmd <> 'r' OR polroles <> ARRAY['hq_api'::REGROLE::OID])
  ), 'every new policy is FOR SELECT TO hq_api only';
  -- Carbon's answer for its user, whatever HQ's authz.subject says.
  ASSERT pg_temp.ids('authenticated', NULL, so, claims) = '{SO-HQF-1,SO-HQF-2,SO-HQF-3}',
    'Carbon''s user sees what Carbon grants';
  ASSERT pg_temp.ids('authenticated', 'user:nobody', so, claims)
    = '{SO-HQF-1,SO-HQF-2,SO-HQF-3}', 'authz.subject narrows nothing for Carbon''s roles';
  ASSERT pg_temp.ids('authenticated', 'user:all-a', so) = '{}',
    'authz.subject widens nothing for Carbon''s roles';
  ASSERT pg_temp.ids('anon', 'user:all-a', so) = '{}', 'nor for anon';
END $$;

SELECT 'saturn-hq-feeds: all checks passed' AS result;
ROLLBACK;
