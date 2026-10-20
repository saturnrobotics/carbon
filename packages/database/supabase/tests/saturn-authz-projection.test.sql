-- Regression test for 20261018214537_saturn-authz-projection.sql (HQ plan 0006B):
-- the projection receiver, the lock on Carbon's permission writers, the readers
-- authz uses, and the EXECUTE matrix; and for
-- 20261020190000_saturn-authz-membership-only.sql: the system employee types
-- membership needs while the lock is on (section 14). The authz roles' grants are checked when
-- HQ's tenant roles (authz_owner, authz_migrator, authz_api) existed at migration.
--
-- Run against a local database migrated to head, as a superuser, on a database
-- without HQ's schema authz (it is stubbed below), for example:
--   psql "postgresql://supabase_admin:postgres@localhost:$PORT_DB/postgres" -X \
--     -v ON_ERROR_STOP=1 -f packages/database/supabase/tests/saturn-authz-projection.test.sql
-- Everything runs in one transaction that is rolled back; nothing persists.
BEGIN;
SET LOCAL search_path = public;

-- Helpers. Each runs one statement as one role in a subtransaction.
CREATE FUNCTION pg_temp.expect_guard(p_role TEXT, p_statement TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL SESSION AUTHORIZATION %I', p_role);
    EXECUTE p_statement;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'Carbon permissions are managed by HQ:%' THEN
      RAISE EXCEPTION 'expected the guard as %, got "%" for: %', p_role, SQLERRM, p_statement;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'the guard let % run: %', p_role, p_statement;
END $$;

CREATE FUNCTION pg_temp.expect_error(p_role TEXT, p_statement TEXT, p_sqlstate TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL SESSION AUTHORIZATION %I', p_role);
    EXECUTE p_statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> p_sqlstate THEN
      RAISE EXCEPTION 'expected SQLSTATE % as %, got % "%" for: %',
        p_sqlstate, p_role, SQLSTATE, SQLERRM, p_statement;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected SQLSTATE % as %, but it ran: %', p_sqlstate, p_role, p_statement;
END $$;

CREATE FUNCTION pg_temp.expect_ok(p_role TEXT, p_statement TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL SESSION AUTHORIZATION %I', p_role);
  EXECUTE p_statement;
  RESET SESSION AUTHORIZATION;
END $$;

CREATE FUNCTION pg_temp.permissions(p_user TEXT) RETURNS JSONB
LANGUAGE sql AS $$ SELECT p.permissions FROM public."userPermission" AS p WHERE p.id = p_user $$;

-- HQ's authz, stubbed with plan 0006B B4's signatures (SECURITY DEFINER, like
-- the real functions) and granted to Carbon's applier as HQ grants them.
CREATE SCHEMA authz;
CREATE TABLE authz.test_subject (auth_uid UUID PRIMARY KEY, subject TEXT);
CREATE TABLE authz.test_projection (subject TEXT PRIMARY KEY, permissions JSONB NOT NULL);
CREATE TABLE authz.test_state (epoch BIGINT NOT NULL);
INSERT INTO authz.test_state VALUES (41);
CREATE FUNCTION authz.subject_of_auth_user(auth_uid UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT s.subject FROM authz.test_subject AS s WHERE s.auth_uid = $1 $$;
CREATE FUNCTION authz.carbon_permissions(subject TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((SELECT p.permissions FROM authz.test_projection AS p WHERE p.subject = $1),
                  '{}'::JSONB)
$$;
CREATE FUNCTION authz.epoch() RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT s.epoch FROM authz.test_state AS s $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authz FROM PUBLIC;
GRANT USAGE ON SCHEMA authz TO carbon_authz_applier;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO carbon_authz_applier;

-- Fixture: two companies; a workforce employee (Google identity), an offboarded
-- workforce employee (HQ identity, disabled in authz), and a customer (no
-- workforce identity). create_public_user creates each user and its '{}' row.
DO $fixture$
DECLARE
  co_a TEXT;
  co_b TEXT;
  et TEXT;
  emp UUID := gen_random_uuid();
  off UUID := gen_random_uuid();
  cust UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.company (name, "baseCurrencyCode")
  VALUES ('Authz Projection Fixture A', 'USD') RETURNING id INTO co_a;
  INSERT INTO public.company (name, "baseCurrencyCode")
  VALUES ('Authz Projection Fixture B', 'USD') RETURNING id INTO co_b;
  -- seed-company creates the company's "All Employees" group, which a new
  -- employee type joins (sync_create_employee_type_group).
  IF to_regclass('public."group"') IS NOT NULL THEN
    INSERT INTO public."group"
      (id, name, "isEmployeeTypeGroup", "isCustomerTypeGroup", "isSupplierTypeGroup", "companyId")
    VALUES ('00000000-0000-' || substring(co_a, 1, 4) || '-' || substring(co_a, 5, 4) || '-'
              || substring(co_a, 9, 12),
            'All Employees', TRUE, FALSE, FALSE, co_a);
  END IF;
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (emp, 'authz-employee@example.com', '{"name": "Authz Employee"}'),
    (off, 'authz-offboarded@example.com', '{}'),
    (cust, 'authz-customer@example.com', '{}');
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider) VALUES
    ('authz-employee-sub', emp, '{"email": "authz-employee@example.com"}', 'google'),
    ('authz-offboarded-sub', off, '{"email": "authz-offboarded@example.com"}', 'keycloak'),
    (cust::TEXT, cust, '{"email": "authz-customer@example.com"}', 'email');
  INSERT INTO public."userToCompany" ("userId", "companyId", role) VALUES
    (emp::TEXT, co_a, 'employee'), (off::TEXT, co_a, 'employee'), (cust::TEXT, co_a, 'customer');
  INSERT INTO public."employeeType" (name, "companyId")
  VALUES ('Authz Projection Fixture Type', co_a) RETURNING id INTO et;
  INSERT INTO public.employee (id, "companyId", "employeeTypeId", active)
  VALUES (emp::TEXT, co_a, et, TRUE), (off::TEXT, co_a, et, TRUE);
  UPDATE public."userPermission"
  SET permissions = jsonb_build_object('sales_view', jsonb_build_array(co_a),
                                       'sales_update', jsonb_build_array(co_a))
  WHERE id IN (emp::TEXT, off::TEXT);
  UPDATE public."userPermission"
  SET permissions = jsonb_build_object('sales_view', jsonb_build_array(co_a))
  WHERE id = cust::TEXT;

  INSERT INTO authz.test_subject VALUES (emp, 'user:authz-employee-sub'), (off, NULL);
  INSERT INTO authz.test_projection VALUES (
    'user:authz-employee-sub',
    jsonb_build_object('sales_view', jsonb_build_array(co_b, co_a, co_a),
                       'parts_view', jsonb_build_array(co_a),
                       'sales_update', '[]'::JSONB)
  );

  PERFORM set_config('test.co_a', co_a, TRUE);
  PERFORM set_config('test.co_b', co_b, TRUE);
  PERFORM set_config('test.et', et, TRUE);
  PERFORM set_config('test.emp', emp::TEXT, TRUE);
  PERFORM set_config('test.off', off::TEXT, TRUE);
  PERFORM set_config('test.cust', cust::TEXT, TRUE);
END $fixture$;

-- 1. Off by default: every writer behaves as before, the receiver refuses -------

DO $$
DECLARE
  r RECORD;
  emp TEXT := current_setting('test.emp');
  cust TEXT := current_setting('test.cust');
  et TEXT := current_setting('test.et');
  co_a TEXT := current_setting('test.co_a');
BEGIN
  ASSERT NOT carbon_private.authz_projection_enabled(), 'the projection must start disabled';
  SELECT * INTO r FROM carbon_private.authz_projection_status();
  ASSERT NOT r.enabled AND r.access_url IS NULL AND r.synced_epoch IS NULL, 'initial status';

  SELECT * INTO r FROM carbon_private.authz_projection_sync();
  ASSERT r.applied IS FALSE AND r.changed = 0 AND r.epoch IS NULL, 'a disabled sync does nothing';
  PERFORM pg_temp.expect_error('postgres',
    format('SELECT carbon_private.authz_apply_projection(%L)', emp), '55000');

  PERFORM pg_temp.expect_ok('service_role', format(
    'UPDATE public."userPermission" SET permissions = permissions || ''{"parts_view": []}'' WHERE id = %L',
    cust));
  PERFORM pg_temp.expect_ok('service_role', format(
    'INSERT INTO public."employeeTypePermission" ("employeeTypeId", module, "view") VALUES (%L, ''Sales'', ARRAY[%L])',
    et, co_a));
  PERFORM pg_temp.expect_ok('postgres', format(
    'UPDATE public."employeeTypePermission" SET "update" = ARRAY[%L] WHERE "employeeTypeId" = %L',
    co_a, et));
  PERFORM pg_temp.expect_ok('postgres', format(
    'UPDATE public."employeeType" SET name = ''Authz Projection Fixture Type 2'' WHERE id = %L', et));
  PERFORM pg_temp.expect_ok(current_user, format(
    'UPDATE public."userPermission" SET permissions = permissions || ''{"parts_view": []}'' WHERE id = %L',
    emp));
  ASSERT NOT EXISTS (SELECT FROM carbon_private.authz_permission_invalidation),
    'nothing is queued while disabled';
END $$;

-- 2. Turning it on needs HQ's origin ------------------------------------------

DO $$
BEGIN
  BEGIN
    UPDATE carbon_private.authz_projection SET enabled = TRUE WHERE singleton;
    ASSERT FALSE, 'enabling without an origin must fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE carbon_private.authz_projection SET hq_origin = 'http://hq.example.com' WHERE singleton;
    ASSERT FALSE, 'a non-https origin must fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE carbon_private.authz_projection SET hq_origin = 'https://hq.example.com/admin' WHERE singleton;
    ASSERT FALSE, 'an origin with a path must fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

UPDATE carbon_private.authz_projection
SET enabled = TRUE, hq_origin = 'https://hq.example.com'
WHERE singleton;

-- 3. The sync writes the exact projection, once ------------------------------

DO $$
DECLARE
  r RECORD;
  emp TEXT := current_setting('test.emp');
  off TEXT := current_setting('test.off');
  cust TEXT := current_setting('test.cust');
  co_a TEXT := current_setting('test.co_a');
  co_b TEXT := current_setting('test.co_b');
  cust_before JSONB := pg_temp.permissions(current_setting('test.cust'));
  queued_before TEXT;
BEGIN
  ASSERT (SELECT s.access_url FROM carbon_private.authz_projection_status() AS s)
    = 'https://hq.example.com/admin/access', 'status names HQ''s access page';

  SELECT * INTO r FROM carbon_private.authz_projection_sync();
  ASSERT r.applied AND r.changed >= 2 AND r.epoch = 41, format('first sync: %s', row_to_json(r));
  ASSERT pg_temp.permissions(emp) = jsonb_build_object(
    'parts_view', jsonb_build_array(co_a),
    'sales_update', '[]'::JSONB,
    'sales_view', (SELECT jsonb_agg(c ORDER BY c) FROM unnest(ARRAY[co_a, co_b]) AS c)
  ), format('employee row is the projection, sorted and de-duplicated: %s', pg_temp.permissions(emp));
  ASSERT pg_temp.permissions(off) = '{}'::JSONB, 'a disabled subject has no permissions';
  ASSERT pg_temp.permissions(cust) = cust_before, 'a user without a workforce identity is untouched';
  ASSERT NOT carbon_private.authz_apply_projection(cust)
    AND pg_temp.permissions(cust) = cust_before, 'and is never projected on its own either';
  ASSERT (SELECT p.synced_epoch FROM carbon_private.authz_projection AS p) = 41, 'cursor recorded';
  ASSERT (SELECT array_agg(q.user_id ORDER BY q.user_id)
          FROM carbon_private.authz_permission_invalidation AS q
          WHERE q.user_id IN (emp, off, cust))
    = (SELECT array_agg(u ORDER BY u) FROM unnest(ARRAY[emp, off]) AS u),
    'both changed users, and only they, are queued for cache invalidation';

  SELECT string_agg(q.user_id || ':' || q.seq, ',' ORDER BY q.seq) INTO queued_before
  FROM carbon_private.authz_permission_invalidation AS q;
  SELECT * INTO r FROM carbon_private.authz_projection_sync();
  ASSERT r.applied AND r.changed = 0, 'a second sync changes nothing';
  ASSERT (SELECT string_agg(q.user_id || ':' || q.seq, ',' ORDER BY q.seq)
          FROM carbon_private.authz_permission_invalidation AS q) = queued_before,
    'a second sync queues nothing';
END $$;

-- 4. The lock: every other writer fails with the guard's error ---------------

DO $$
DECLARE
  emp TEXT := current_setting('test.emp');
  et TEXT := current_setting('test.et');
  co_a TEXT := current_setting('test.co_a');
  writer TEXT;
  statement TEXT;
BEGIN
  FOREACH writer IN ARRAY ARRAY['service_role', 'postgres', current_user] LOOP
    FOREACH statement IN ARRAY ARRAY[
      -- ERP updatePermissions, Inngest update-permissions, SSO provisioning
      format('UPDATE public."userPermission" SET permissions = permissions || jsonb_build_object(''sales_delete'', jsonb_build_array(%L)) WHERE id = %L', co_a, emp),
      -- an upstream migration adding a module (20260810100100_workflows-foundation.sql)
      'UPDATE public."userPermission" SET permissions = permissions || jsonb_build_object(''workflows_view'', COALESCE(permissions -> ''settings_view'', ''[]''::jsonb))',
      -- employee type screens, MCP users_* tools, company creation, console mode
      format('INSERT INTO public."employeeType" (name, "companyId") VALUES (''Locked'', %L)', co_a),
      format('UPDATE public."employeeType" SET name = ''Renamed'' WHERE id = %L', et),
      format('INSERT INTO public."employeeTypePermission" ("employeeTypeId", module) VALUES (%L, ''Parts'')', et),
      format('UPDATE public."employeeTypePermission" SET "delete" = ARRAY[%L] WHERE "employeeTypeId" = %L', co_a, et),
      'TRUNCATE public."userPermission"',
      'TRUNCATE public."employeeTypePermission"'
    ] LOOP
      PERFORM pg_temp.expect_guard(writer, statement);
    END LOOP;
  END LOOP;

  -- A write that changes nothing is not a change.
  PERFORM pg_temp.expect_ok('service_role', format(
    'UPDATE public."userPermission" SET permissions = permissions WHERE id = %L', emp));
  PERFORM pg_temp.expect_ok('service_role', format(
    'UPDATE public."employeeType" SET name = name WHERE id = %L', et));

  -- Invite acceptance's upsert lands the projection on a synced row: no change.
  PERFORM pg_temp.expect_ok('service_role', format(
    'INSERT INTO public."userPermission" (id, permissions) VALUES (%L, jsonb_build_object(''sales_delete'', jsonb_build_array(%L))) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions',
    emp, co_a));
  ASSERT NOT pg_temp.permissions(emp) ? 'sales_delete', 'the upsert cannot add a permission';
END $$;

-- 5. New and deleted rows ------------------------------------------------------

DO $$
DECLARE
  r RECORD;
  emp TEXT := current_setting('test.emp');
  off TEXT := current_setting('test.off');
  co_a TEXT := current_setting('test.co_a');
  newcomer UUID := gen_random_uuid();
  projected JSONB := pg_temp.permissions(current_setting('test.emp'));
BEGIN
  -- Deleting never grants access (and cascades from deleting a user or company);
  -- the next sync restores the projection.
  PERFORM pg_temp.expect_ok('service_role', format(
    'DELETE FROM public."userPermission" WHERE id = %L', off));
  ASSERT pg_temp.permissions(off) IS NULL, 'the delete went through';

  -- A row re-created outside the projection path is born as the projection.
  PERFORM pg_temp.expect_ok('service_role', format(
    'DELETE FROM public."userPermission" WHERE id = %L', emp));
  PERFORM pg_temp.expect_ok('service_role', format(
    'INSERT INTO public."userPermission" (id, permissions) VALUES (%L, ''{"sales_delete": ["forged"]}'')',
    emp));
  ASSERT pg_temp.permissions(emp) = projected,
    format('an inserted row is the projection, not the writer''s value: %s', pg_temp.permissions(emp));

  -- GoTrue signs a new person up (create_public_user): no identity is linked yet,
  -- so the row starts empty and the next sync projects it.
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (newcomer, 'authz-newcomer@example.com', '{}');
  ASSERT pg_temp.permissions(newcomer::TEXT) = '{}'::JSONB, 'a new user starts with nothing';
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  VALUES ('authz-newcomer-sub', newcomer, '{"email": "authz-newcomer@example.com"}', 'keycloak');
  INSERT INTO authz.test_subject VALUES (newcomer, 'user:authz-newcomer-sub');
  INSERT INTO authz.test_projection
  VALUES ('user:authz-newcomer-sub', jsonb_build_object('documents_view', jsonb_build_array(co_a)));

  SELECT * INTO r FROM carbon_private.authz_projection_sync();
  ASSERT r.changed >= 2, format('the sync restores and projects: %s', row_to_json(r));
  ASSERT pg_temp.permissions(off) = '{}'::JSONB, 'a deleted row is restored as the projection';
  ASSERT pg_temp.permissions(newcomer::TEXT)
    = jsonb_build_object('documents_view', jsonb_build_array(co_a)), 'the newcomer is projected';
  ASSERT EXISTS (SELECT FROM carbon_private.authz_permission_invalidation AS q
                 WHERE q.user_id = newcomer::TEXT), 'the newcomer''s cache is queued';
  PERFORM set_config('test.newcomer', newcomer::TEXT, TRUE);
END $$;

-- 6. Grants, revokes and disabling reach Carbon through the sync --------------

DO $$
DECLARE
  emp TEXT := current_setting('test.emp');
  co_a TEXT := current_setting('test.co_a');
  seq_before BIGINT;
BEGIN
  SELECT q.seq INTO seq_before FROM carbon_private.authz_permission_invalidation AS q
  WHERE q.user_id = emp;

  UPDATE authz.test_projection
  SET permissions = permissions || jsonb_build_object('sales_delete', jsonb_build_array(co_a))
  WHERE subject = 'user:authz-employee-sub';
  PERFORM carbon_private.authz_projection_sync();
  ASSERT pg_temp.permissions(emp) -> 'sales_delete' = jsonb_build_array(co_a), 'a grant arrives';
  ASSERT (SELECT q.seq FROM carbon_private.authz_permission_invalidation AS q WHERE q.user_id = emp)
    > seq_before, 'a re-queued user gets a newer seq';

  UPDATE authz.test_projection SET permissions = permissions - 'sales_delete'
  WHERE subject = 'user:authz-employee-sub';
  PERFORM carbon_private.authz_projection_sync();
  ASSERT NOT pg_temp.permissions(emp) ? 'sales_delete', 'a revoke arrives';

  UPDATE authz.test_subject SET subject = NULL WHERE auth_uid = emp::UUID;
  PERFORM carbon_private.authz_projection_sync();
  ASSERT pg_temp.permissions(emp) = '{}'::JSONB, 'disabling the subject empties the projection';
  UPDATE authz.test_subject SET subject = 'user:authz-employee-sub' WHERE auth_uid = emp::UUID;
  PERFORM carbon_private.authz_projection_sync();
  ASSERT pg_temp.permissions(emp) ? 'sales_view', 're-enabling restores it';
END $$;

-- 7. Malformed projections are refused, and nothing is written -----------------

DO $$
DECLARE
  emp TEXT := current_setting('test.emp');
  before JSONB := pg_temp.permissions(current_setting('test.emp'));
  good JSONB := (SELECT p.permissions FROM authz.test_projection AS p
                 WHERE p.subject = 'user:authz-employee-sub');
  bad JSONB;
BEGIN
  FOREACH bad IN ARRAY ARRAY[
    '[]', 'null', '{"nonsense_view": []}', '{"sales_approve": []}', '{"sales": []}',
    '{"Sales_view": []}', '{"sales_view": "company"}', '{"sales_view": ["0"]}',
    '{"sales_view": [""]}', '{"sales_view": [1]}', '{"sales_view": [null]}'
  ]::JSONB[] LOOP
    UPDATE authz.test_projection SET permissions = bad WHERE subject = 'user:authz-employee-sub';
    PERFORM pg_temp.expect_error('postgres',
      format('SELECT carbon_private.authz_apply_projection(%L)', emp), '22023');
    PERFORM pg_temp.expect_error('postgres',
      'SELECT * FROM carbon_private.authz_projection_sync()', '22023');
    ASSERT pg_temp.permissions(emp) = before, format('nothing written for %s', bad);
  END LOOP;
  UPDATE authz.test_projection SET permissions = good WHERE subject = 'user:authz-employee-sub';

  -- Without authz the sync and new-row path fail closed.
  BEGIN
    DROP FUNCTION authz.carbon_permissions(TEXT);
    PERFORM carbon_private.authz_projection_sync();
    ASSERT FALSE, 'a sync without authz must fail';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
END $$;

-- 8. Nobody else can raise the projection path or flip the lock ---------------

DO $$
DECLARE
  emp TEXT := current_setting('test.emp');
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['service_role', 'postgres'] LOOP
    PERFORM pg_temp.expect_error(r,
      'INSERT INTO carbon_private.authz_projection_writer (xact) VALUES (pg_current_xact_id())',
      '42501');
    PERFORM pg_temp.expect_error(r,
      format('SELECT carbon_private.authz_write_permissions(%L, ''{}'')', emp), '42501');
    PERFORM pg_temp.expect_error(r, 'SET ROLE carbon_authz_applier', '42501');
    PERFORM pg_temp.expect_error(r,
      'UPDATE carbon_private.authz_projection SET enabled = FALSE', '42501');
    PERFORM pg_temp.expect_error(r,
      'DELETE FROM carbon_private.authz_permission_invalidation', '42501');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    PERFORM pg_temp.expect_error(r, 'SELECT carbon_private.authz_projection_enabled()', '42501');
    PERFORM pg_temp.expect_error(r, 'SELECT * FROM carbon_private.authz_memberships()', '42501');
  END LOOP;
END $$;

-- 9. Grants, owners and settings -----------------------------------------------

DO $$
DECLARE
  bad TEXT;
BEGIN
  WITH expected(fn, grantees) AS (VALUES
    ('authz_projection_enabled()', ARRAY['carbon_authz_applier', 'postgres', 'supabase_auth_admin']),
    ('authz_projection_status()', ARRAY['postgres']),
    ('authz_modules()', ARRAY['carbon_authz_applier']),
    ('authz_memberships()', ARRAY[]::TEXT[]),
    ('authz_user_permissions()', ARRAY[]::TEXT[]),
    ('authz_employee_type_permissions()', ARRAY[]::TEXT[]),
    -- 20261020154924_saturn-authz-identities; tested in saturn-authz-identities.test.sql.
    ('authz_identities()', ARRAY[]::TEXT[]),
    ('authz_is_workforce_user(text)', ARRAY['carbon_authz_applier']),
    ('authz_workforce_users()', ARRAY['carbon_authz_applier']),
    ('authz_canonical_permissions(jsonb)', ARRAY['carbon_authz_applier']),
    ('authz_validated_projection(jsonb)', ARRAY['carbon_authz_applier']),
    ('authz_write_permissions(text,jsonb)', ARRAY['carbon_authz_applier']),
    ('authz_record_sync(bigint)', ARRAY['carbon_authz_applier']),
    ('authz_pending_invalidations(integer)', ARRAY['postgres']),
    ('authz_ack_invalidations(bigint[])', ARRAY['postgres']),
    ('authz_projection_for(text)', ARRAY['carbon_authz_applier', 'postgres']),
    ('authz_apply_projection(text)', ARRAY['carbon_authz_applier', 'postgres']),
    ('authz_projection_sync()', ARRAY['carbon_authz_applier', 'postgres']),
    ('authz_permission_guard()', ARRAY[]::TEXT[]),
    ('authz_ensure_system_employee_type(text,text)', ARRAY['postgres'])
  ),
  roles(name) AS (VALUES ('anon'), ('authenticated'), ('service_role'), ('postgres'),
                         ('supabase_auth_admin'), ('carbon_authz_applier')),
  actual AS (
    SELECT e.fn, r.name,
      has_function_privilege(r.name, ('carbon_private.' || e.fn)::REGPROCEDURE, 'EXECUTE') AS can,
      r.name = ANY (e.grantees) AS should
    FROM expected AS e CROSS JOIN roles AS r
    WHERE NOT (SELECT rolsuper FROM pg_roles WHERE rolname = r.name)
  )
  SELECT string_agg(format('%s %s %s', a.fn, a.name, CASE WHEN a.can THEN 'can' ELSE 'cannot' END), '; ')
  INTO bad FROM actual AS a WHERE a.can <> a.should;
  ASSERT bad IS NULL, format('EXECUTE matrix differs: %s', bad);

  SELECT string_agg(p.proname, ', ') INTO bad
  FROM pg_proc AS p
  WHERE p.pronamespace = 'carbon_private'::REGNAMESPACE AND p.proname LIKE 'authz\_%'
    AND (p.proacl IS NULL
         OR EXISTS (SELECT FROM aclexplode(p.proacl) AS a WHERE a.grantee = 0)
         OR p.proconfig IS NULL OR NOT ('search_path=""' = ANY (p.proconfig)));
  ASSERT bad IS NULL, format('PUBLIC EXECUTE or a search_path other than '''': %s', bad);
  ASSERT (SELECT count(*) FROM pg_proc AS p
          WHERE p.pronamespace = 'carbon_private'::REGNAMESPACE AND p.proname LIKE 'authz\_%') = 20,
    'every function is covered above';

  ASSERT (SELECT array_agg(p.proname::TEXT ORDER BY p.proname) FROM pg_proc AS p
          WHERE p.pronamespace = 'carbon_private'::REGNAMESPACE
            AND p.proowner = 'carbon_authz_applier'::REGROLE)
    = ARRAY['authz_apply_projection', 'authz_projection_for', 'authz_projection_sync'],
    'the applier owns exactly the functions that call authz';
  ASSERT (SELECT NOT (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)
          FROM pg_roles WHERE rolname = 'carbon_authz_applier'), 'the applier is NOLOGIN and plain';
  -- The Supabase CLI migrates as postgres, the apps' own role; the lock's state
  -- and its writer must still belong to the administrator.
  ASSERT (SELECT r.rolsuper FROM pg_class AS c JOIN pg_roles AS r ON r.oid = c.relowner
          WHERE c.oid = 'carbon_private.authz_projection_writer'::REGCLASS),
    'the lock''s state is owned by a superuser, not the apps'' role';
  ASSERT (SELECT r.rolsuper FROM pg_proc AS p JOIN pg_roles AS r ON r.oid = p.proowner
          WHERE p.oid = 'carbon_private.authz_write_permissions(text,jsonb)'::REGPROCEDURE),
    'the writer is owned by a superuser';
  ASSERT (SELECT r.rolsuper FROM pg_proc AS p JOIN pg_roles AS r ON r.oid = p.proowner
          WHERE p.oid = 'carbon_private.authz_ensure_system_employee_type(text,text)'::REGPROCEDURE),
    'the system employee type writer is owned by a superuser';
  ASSERT NOT EXISTS (SELECT FROM pg_auth_members WHERE roleid = 'carbon_authz_applier'::REGROLE),
    'nobody can SET ROLE to the applier';

  SELECT string_agg(format('%s on %s', r.name, c.relname), '; ') INTO bad
  FROM pg_class AS c
  CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role'), ('postgres'),
                     ('supabase_auth_admin'), ('carbon_authz_applier')) AS r(name)
  WHERE c.relnamespace = 'carbon_private'::REGNAMESPACE AND c.relname LIKE 'authz\_%'
    AND c.relkind IN ('r', 'S')
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = r.name)
    AND (CASE WHEN c.relkind = 'S'
              THEN has_sequence_privilege(r.name, c.oid, 'USAGE,UPDATE')
              ELSE has_table_privilege(r.name, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
         END
         -- Reading needs a grant too, except for pg_read_all_data's members
         -- (Supabase's postgres role reads every table).
         OR (NOT pg_has_role(r.name, 'pg_read_all_data', 'USAGE')
             AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.name, c.oid, 'SELECT')
                      ELSE has_table_privilege(r.name, c.oid, 'SELECT') END));
  ASSERT bad IS NULL, format('direct access to the projection''s tables: %s', bad);

  ASSERT (SELECT count(*) FROM pg_trigger AS t
          WHERE t.tgname IN ('saturn_authz_permission_guard', 'saturn_authz_permission_guard_truncate')
            AND t.tgrelid IN ('public."userPermission"'::REGCLASS, 'public."employeeType"'::REGCLASS,
                              'public."employeeTypePermission"'::REGCLASS)) = 6,
    'guards on all three tables';
END $$;

-- 10. What authz reads ----------------------------------------------------------

DO $$
DECLARE
  emp TEXT := current_setting('test.emp');
  cust TEXT := current_setting('test.cust');
  co_a TEXT := current_setting('test.co_a');
  et TEXT := current_setting('test.et');
BEGIN
  ASSERT (SELECT count(*) FROM carbon_private.authz_modules())
    = cardinality(enum_range(NULL::public.module)), 'one catalog row per module';
  ASSERT EXISTS (SELECT FROM carbon_private.authz_modules() AS m
                 WHERE m.module = 'Sales' AND m.permission_prefix = 'sales'), 'Sales is sales_*';
  ASSERT (SELECT array_agg(m.sort_order ORDER BY m.sort_order) FROM carbon_private.authz_modules() AS m)
    = (SELECT array_agg(i) FROM generate_series(1, cardinality(enum_range(NULL::public.module))) AS i),
    'enum order';
  ASSERT EXISTS (SELECT FROM carbon_private.authz_memberships() AS m
                 WHERE m.user_id = emp AND m.company_id = co_a AND m.role = 'employee'
                   AND m.employee_type_id = et AND m.employee_active
                   AND m.email = 'authz-employee@example.com'), 'employee membership';
  ASSERT EXISTS (SELECT FROM carbon_private.authz_memberships() AS m
                 WHERE m.user_id = cust AND m.role = 'customer' AND m.employee_type_id IS NULL),
    'customer membership';
END $$;

-- 11. The invalidation queue ------------------------------------------------------

DO $$
DECLARE
  emp TEXT := current_setting('test.emp');
  old_seq BIGINT;
  acked INTEGER;
BEGIN
  SELECT q.seq INTO old_seq FROM carbon_private.authz_pending_invalidations(5000) AS q
  WHERE q.user_id = emp;
  ASSERT old_seq IS NOT NULL, 'the employee is pending';
  -- The user is re-queued after the job read the queue: the stale ack keeps it.
  UPDATE authz.test_projection
  SET permissions = permissions || '{"invoicing_view": []}' WHERE subject = 'user:authz-employee-sub';
  PERFORM carbon_private.authz_projection_sync();
  acked := carbon_private.authz_ack_invalidations(ARRAY[old_seq]);
  ASSERT acked = 0, 'an ack for an older seq removes nothing';
  ASSERT EXISTS (SELECT FROM carbon_private.authz_pending_invalidations(5000) AS q
                 WHERE q.user_id = emp), 'the newer change is still pending';
  acked := carbon_private.authz_ack_invalidations(
    ARRAY(SELECT q.seq FROM carbon_private.authz_pending_invalidations(5000) AS q));
  ASSERT acked >= 1 AND NOT EXISTS (SELECT FROM carbon_private.authz_pending_invalidations(5000)),
    'acknowledging every pending seq drains the queue';
END $$;

-- 12. Off again: Carbon's writers work as before -------------------------------

UPDATE carbon_private.authz_projection SET enabled = FALSE WHERE singleton;
DO $$
DECLARE
  emp TEXT := current_setting('test.emp');
  et TEXT := current_setting('test.et');
BEGIN
  PERFORM pg_temp.expect_ok('service_role', format(
    'UPDATE public."userPermission" SET permissions = ''{"parts_view": []}'' WHERE id = %L', emp));
  PERFORM pg_temp.expect_ok('service_role', format(
    'UPDATE public."employeeType" SET name = ''Unlocked'' WHERE id = %L', et));
  ASSERT pg_temp.permissions(emp) = '{"parts_view": []}'::JSONB, 'the write landed';
END $$;

-- 13. The stored-permission readers (authz's seed and C3 gate) -----------------

DO $$
DECLARE
  emp TEXT := current_setting('test.emp');
  off TEXT := current_setting('test.off');
  et TEXT := current_setting('test.et');
  co_a TEXT := current_setting('test.co_a');
  co_b TEXT := current_setting('test.co_b');
  raw JSONB := jsonb_build_object('sales_view', jsonb_build_array(co_b, co_a, co_b),
                                  'parts_view', '[]'::JSONB);
  fn TEXT;
  r TEXT;
  owner_can TEXT[] := ARRAY['authz_modules()', 'authz_memberships()',
    'authz_user_permissions()', 'authz_employee_type_permissions()',
    'authz_projection_status()', 'authz_apply_projection(text)', 'authz_identities()'];
  api_can TEXT[] := ARRAY['authz_memberships()', 'authz_projection_status()'];
BEGIN
  -- Exact signatures: hq-authz depends on them.
  ASSERT pg_get_function_result('carbon_private.authz_user_permissions()'::REGPROCEDURE)
    = 'TABLE(user_id text, permissions jsonb)', 'authz_user_permissions signature';
  ASSERT pg_get_function_result('carbon_private.authz_employee_type_permissions()'::REGPROCEDURE)
    = 'TABLE(employee_type_id text, module text, action text, company_ids text[])',
    'authz_employee_type_permissions signature';

  -- Raw values: not sorted, not de-duplicated, NULL kept.
  UPDATE public."userPermission" SET permissions = raw WHERE id = emp;
  UPDATE public."userPermission" SET permissions = NULL WHERE id = off;
  ASSERT (SELECT u.permissions FROM carbon_private.authz_user_permissions() AS u
          WHERE u.user_id = emp) = raw, 'userPermission is returned as stored';
  ASSERT (SELECT u.permissions::TEXT FROM carbon_private.authz_user_permissions() AS u
          WHERE u.user_id = emp) = raw::TEXT, 'array order and duplicates kept';
  ASSERT EXISTS (SELECT FROM carbon_private.authz_user_permissions() AS u
                 WHERE u.user_id = off AND u.permissions IS NULL), 'a NULL row is returned as NULL';
  ASSERT (SELECT count(*) FROM carbon_private.authz_user_permissions())
    = (SELECT count(*) FROM public."userPermission"), 'one row per userPermission row';
  ASSERT (SELECT array_agg(u.user_id ORDER BY u.ord)
          FROM carbon_private.authz_user_permissions() WITH ORDINALITY AS u(user_id, permissions, ord))
    = (SELECT array_agg(u.user_id ORDER BY u.user_id)
       FROM carbon_private.authz_user_permissions() AS u), 'ordered by user_id';

  -- One row per (template row, action), arrays as stored, empty ones included.
  INSERT INTO public."employeeTypePermission" ("employeeTypeId", module, "view", "create")
  VALUES (et, 'Parts', ARRAY[co_b, co_a, co_b], ARRAY[co_a]);
  ASSERT (SELECT array_agg(format('%s/%s/%s', e.module, e.action, e.company_ids) ORDER BY e.ord)
          FROM carbon_private.authz_employee_type_permissions() WITH ORDINALITY
            AS e(employee_type_id, module, action, company_ids, ord)
          WHERE e.employee_type_id = et)
    = ARRAY[
        format('Parts/create/{%s}', co_a), 'Parts/delete/{}', 'Parts/update/{}',
        format('Parts/view/{%s,%s,%s}', co_b, co_a, co_b),
        'Sales/create/{}', 'Sales/delete/{}', format('Sales/update/{%s}', co_a),
        format('Sales/view/{%s}', co_a)
      ], 'template rows by module and action, arrays as stored';
  ASSERT (SELECT count(*) FROM carbon_private.authz_employee_type_permissions())
    = 4 * (SELECT count(*) FROM public."employeeTypePermission"), 'four actions per row';
  ASSERT (SELECT array_agg(ARRAY[e.employee_type_id, e.module, e.action] ORDER BY e.ord)
          FROM carbon_private.authz_employee_type_permissions() WITH ORDINALITY
            AS e(employee_type_id, module, action, company_ids, ord))
    = (SELECT array_agg(ARRAY[e.employee_type_id, e.module, e.action]
                        ORDER BY e.employee_type_id, e.module, e.action)
       FROM carbon_private.authz_employee_type_permissions() AS e), 'ordered by 1, 2, 3';
  ASSERT NOT EXISTS (SELECT FROM carbon_private.authz_employee_type_permissions() AS e
                     WHERE e.module NOT IN (SELECT m.module FROM carbon_private.authz_modules() AS m)
                        OR e.action NOT IN ('view', 'create', 'update', 'delete')
                        OR e.company_ids IS NULL),
    'modules are catalog labels, actions the four, arrays never NULL';

  -- Client roles cannot read them.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH fn IN ARRAY ARRAY['authz_user_permissions()', 'authz_employee_type_permissions()'] LOOP
      PERFORM pg_temp.expect_error(r, format('SELECT * FROM carbon_private.%s', fn), '42501');
    END LOOP;
  END LOOP;

  -- HQ's roles, when they existed at migration time.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authz_owner') THEN
    FOREACH fn IN ARRAY ARRAY(
      SELECT p.oid::REGPROCEDURE::TEXT FROM pg_proc AS p
      WHERE p.pronamespace = 'carbon_private'::REGNAMESPACE AND p.proname LIKE 'authz\_%'
    ) LOOP
      ASSERT has_function_privilege('authz_owner', fn, 'EXECUTE')
        = (replace(fn, 'carbon_private.', '') = ANY (owner_can)),
        format('authz_owner EXECUTE on %s', fn);
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authz_api') THEN
        ASSERT has_function_privilege('authz_api', fn, 'EXECUTE')
          = (replace(fn, 'carbon_private.', '') = ANY (api_can)),
          format('authz_api EXECUTE on %s', fn);
      END IF;
    END LOOP;
    PERFORM pg_temp.expect_ok('authz_owner', 'SELECT * FROM carbon_private.authz_user_permissions()');
    PERFORM pg_temp.expect_ok('authz_owner', 'SELECT * FROM carbon_private.authz_employee_type_permissions()');
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authz_migrator')
      AND pg_has_role('authz_migrator', 'authz_owner', 'USAGE')
    THEN
      PERFORM pg_temp.expect_ok('authz_migrator', 'SELECT * FROM carbon_private.authz_user_permissions()');
      PERFORM pg_temp.expect_ok('authz_migrator', 'SELECT * FROM carbon_private.authz_employee_type_permissions()');
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authz_api') THEN
      PERFORM pg_temp.expect_error('authz_api', 'SELECT * FROM carbon_private.authz_user_permissions()', '42501');
      PERFORM pg_temp.expect_error('authz_api', 'SELECT * FROM carbon_private.authz_employee_type_permissions()', '42501');
    END IF;
    RAISE NOTICE 'authz roles: grants checked';
  ELSE
    RAISE NOTICE 'authz roles absent at migration: their grants come from HQ''s tenants.sql';
  END IF;
END $$;

-- 14. Membership while the lock is on: system employee types ------------------
-- (20261020190000_saturn-authz-membership-only.sql) employee."employeeTypeId" is
-- NOT NULL, so company creation and console mode need a type; the writer creates
-- one with no template and touches nothing else.

CREATE FUNCTION pg_temp.ensure_type(p_role TEXT, p_company TEXT, p_type TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_id TEXT;
BEGIN
  EXECUTE format('SET LOCAL SESSION AUTHORIZATION %I', p_role);
  v_id := carbon_private.authz_ensure_system_employee_type(p_company, p_type);
  RESET SESSION AUTHORIZATION;
  RETURN v_id;
END $$;

UPDATE carbon_private.authz_projection SET enabled = TRUE WHERE singleton;
DO $$
DECLARE
  co_a TEXT := current_setting('test.co_a');
  emp TEXT := current_setting('test.emp');
  perms_before JSONB := pg_temp.permissions(current_setting('test.emp'));
  queued_before BIGINT := (SELECT count(*) FROM carbon_private.authz_permission_invalidation);
  admin_id TEXT;
  console_id TEXT;
  r TEXT;
BEGIN
  ASSERT carbon_private.authz_projection_enabled(), 'the lock is on';

  -- Only the apps' own connection may call it.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM pg_temp.expect_error(r, format(
      'SELECT carbon_private.authz_ensure_system_employee_type(%L, ''Admin'')', co_a), '42501');
  END LOOP;

  -- Upstream's own inserts are still refused: the lock is unchanged.
  PERFORM pg_temp.expect_guard('postgres', format(
    'INSERT INTO public."employeeType" (name, "companyId", protected, "systemType") VALUES (''Admin'', %L, TRUE, ''Admin'')',
    co_a));
  ASSERT NOT EXISTS (SELECT FROM public."employeeType" WHERE "companyId" = co_a
                     AND "systemType" IS NOT NULL), 'no system type yet';

  -- A type that something gives template rows in the same statement is refused,
  -- and nothing of it remains.
  BEGIN
    CREATE FUNCTION public.saturn_test_template() RETURNS TRIGGER LANGUAGE plpgsql AS $t$
    BEGIN
      INSERT INTO public."employeeTypePermission" ("employeeTypeId", module, "view")
      VALUES (NEW.id, 'Parts', ARRAY[NEW."companyId"]);
      RETURN NEW;
    END $t$;
    CREATE TRIGGER saturn_test_template AFTER INSERT ON public."employeeType"
      FOR EACH ROW EXECUTE FUNCTION public.saturn_test_template();
    PERFORM pg_temp.ensure_type('postgres', co_a, 'Admin');
    RAISE EXCEPTION 'a type with template rows was created';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLERRM LIKE 'Carbon permissions are managed by HQ:%', SQLERRM;
  END;
  RESET SESSION AUTHORIZATION;
  ASSERT to_regprocedure('public.saturn_test_template()') IS NULL, 'the mutation is gone';
  ASSERT NOT EXISTS (SELECT FROM public."employeeType" WHERE "companyId" = co_a
                     AND "systemType" IS NOT NULL), 'and so is its type';

  -- The writer: protected, named for its system type, no template.
  admin_id := pg_temp.ensure_type('postgres', co_a, 'Admin');
  ASSERT EXISTS (SELECT FROM public."employeeType" AS et
                 WHERE et.id = admin_id AND et."companyId" = co_a AND et.name = 'Admin'
                   AND et.protected AND et."systemType" = 'Admin'), 'the Admin type';
  ASSERT NOT EXISTS (SELECT FROM public."employeeTypePermission" WHERE "employeeTypeId" = admin_id),
    'with no template permissions';
  ASSERT pg_temp.ensure_type('postgres', co_a, 'Admin') = admin_id, 'idempotent';
  ASSERT (SELECT count(*) FROM public."employeeType" WHERE "companyId" = co_a
            AND "systemType" = 'Admin') = 1, 'one Admin type';

  console_id := pg_temp.ensure_type('postgres', co_a, 'Console Operator');
  ASSERT console_id IS NOT NULL AND console_id <> admin_id
    AND (SELECT name FROM public."employeeType" WHERE id = console_id) = 'Console Operator',
    'the Console Operator type';

  -- The flag is down again: the template and the type stay locked.
  ASSERT NOT EXISTS (SELECT FROM carbon_private.authz_projection_writer), 'flag cleared';
  PERFORM pg_temp.expect_guard('postgres', format(
    'INSERT INTO public."employeeTypePermission" ("employeeTypeId", module, "view") VALUES (%L, ''Sales'', ARRAY[%L])',
    admin_id, co_a));
  PERFORM pg_temp.expect_guard('postgres', format(
    'UPDATE public."employeeType" SET name = ''Owner'' WHERE id = %L', admin_id));

  -- Membership can point at it; permissions are untouched.
  PERFORM pg_temp.expect_ok('postgres', format(
    'UPDATE public.employee SET "employeeTypeId" = %L WHERE id = %L AND "companyId" = %L',
    admin_id, emp, co_a));
  ASSERT pg_temp.permissions(emp) = perms_before, 'userPermission unchanged';
  ASSERT (SELECT count(*) FROM carbon_private.authz_permission_invalidation) = queued_before,
    'nothing queued';

  -- Anything but a system type, or no company, is refused.
  PERFORM pg_temp.expect_error('postgres', format(
    'SELECT carbon_private.authz_ensure_system_employee_type(%L, ''Ops'')', co_a), '22P02');
  PERFORM pg_temp.expect_error('postgres',
    'SELECT carbon_private.authz_ensure_system_employee_type(NULL, ''Admin'')', '22023');
  PERFORM pg_temp.expect_error('postgres',
    'SELECT carbon_private.authz_ensure_system_employee_type(''no-such-company'', ''Admin'')', '23503');
END $$;
UPDATE carbon_private.authz_projection SET enabled = FALSE WHERE singleton;

SELECT 'saturn-authz-projection: all checks passed' AS result;
ROLLBACK;
