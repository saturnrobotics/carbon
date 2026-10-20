-- Regression test for 20261020154924_saturn-authz-identities.sql (HQ plan 0006B
-- B4 and B10): the reader hq-authz uses for GoTrue's sign-in identities, its
-- shape, its independence from row level security on auth.identities, its
-- EXECUTE grants, and the guard that grants it only where HQ's authz_owner exists.
--
-- Run against a local database migrated to head, as a superuser, on a database
-- without HQ's authz roles (they are stubbed below), for example:
--   psql "postgresql://supabase_admin:postgres@localhost:$PORT_DB/postgres" -X \
--     -v ON_ERROR_STOP=1 -f packages/database/supabase/tests/saturn-authz-identities.test.sql
-- The migration is idempotent, so the test runs it again with \ir once the
-- stand-in roles exist. Everything runs in one transaction that is rolled back;
-- nothing persists.
BEGIN;
SET LOCAL search_path = public;

-- Helpers. Each runs one query as one role.
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

-- The query's first column as text, sorted.
CREATE FUNCTION pg_temp.rows_as(p_role TEXT, p_query TEXT) RETURNS TEXT[]
LANGUAGE plpgsql AS $$
DECLARE
  v_result TEXT[];
BEGIN
  EXECUTE format('SET LOCAL SESSION AUTHORIZATION %I', p_role);
  EXECUTE format('SELECT coalesce(array_agg(x::TEXT ORDER BY x::TEXT), ''{}'') FROM (%s) AS q (x)',
                 p_query)
    INTO v_result;
  RESET SESSION AUTHORIZATION;
  RETURN v_result;
END $$;

CREATE FUNCTION pg_temp.identities_of(p_user TEXT) RETURNS TEXT
LANGUAGE sql AS $$
  SELECT format('SELECT i.provider || ''/'' || i.provider_id'
                ' FROM carbon_private.authz_identities() AS i WHERE i.user_id = %L', p_user)
$$;

CREATE FUNCTION pg_temp.acl() RETURNS TEXT[]
LANGUAGE sql AS $$
  SELECT array_agg(format('%s=%s', a.grantee::REGROLE, a.privilege_type)
                   ORDER BY a.grantee::REGROLE::TEXT)
  FROM pg_proc AS p, aclexplode(p.proacl) AS a
  WHERE p.oid = 'carbon_private.authz_identities()'::REGPROCEDURE
$$;

-- 1. At head on Carbon's own database: the shape, and the guard granted nothing --

DO $$
DECLARE
  fn REGPROCEDURE := 'carbon_private.authz_identities()'::REGPROCEDURE;
  owner_name TEXT := (SELECT pg_get_userbyid(p.proowner) FROM pg_proc AS p
                      WHERE p.oid = 'carbon_private.authz_identities()'::REGPROCEDURE);
BEGIN
  IF EXISTS (SELECT FROM pg_roles
             WHERE rolname IN ('authz_owner', 'authz_migrator', 'authz_api')) THEN
    RAISE EXCEPTION 'run this test on Carbon''s own database: HQ''s authz roles exist';
  END IF;

  -- Exact signature: hq-authz depends on it.
  ASSERT pg_get_function_identity_arguments(fn) = '', 'no arguments';
  ASSERT pg_get_function_result(fn) = 'TABLE(user_id text, provider text, provider_id text)',
    format('authz_identities signature: %s', pg_get_function_result(fn));
  ASSERT (SELECT p.provolatile = 's' AND p.prosecdef
                 AND p.proconfig = ARRAY['search_path=""']
          FROM pg_proc AS p WHERE p.oid = fn), 'STABLE SECURITY DEFINER with search_path ''''';
  ASSERT (SELECT r.rolsuper FROM pg_roles AS r WHERE r.rolname = owner_name),
    'owned by the administrator, which row level security does not apply to';

  -- No authz_owner at migration time: only the owner may run it, and PUBLIC never.
  ASSERT pg_temp.acl() = ARRAY[format('%s=EXECUTE', owner_name)],
    format('only the owner holds EXECUTE without HQ''s roles: %s', pg_temp.acl());
END $$;

-- 2. Fixture: four people and their GoTrue identities ---------------------------

DO $fixture$
DECLARE
  u_google UUID := gen_random_uuid();
  u_hq UUID := gen_random_uuid();
  u_both UUID := gen_random_uuid();
  u_email UUID := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (u_google, 'identities-google@example.com', '{}'),
    (u_hq, 'identities-hq@example.com', '{}'),
    (u_both, 'identities-both@example.com', '{}'),
    (u_email, 'identities-email@example.com', '{}');
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider) VALUES
    ('identities-google-sub', u_google, '{"email": "identities-google@example.com"}', 'google'),
    ('identities-google-gh', u_google, '{"email": "identities-google@example.com"}', 'github'),
    ('identities-hq-sub', u_hq, '{"email": "identities-hq@example.com"}', 'keycloak'),
    ('identities-both-sub', u_both, '{"email": "identities-both@example.com"}', 'google'),
    ('identities-both-sub', u_both, '{"email": "identities-both@example.com"}', 'keycloak'),
    (u_both::TEXT, u_both, '{"email": "identities-both@example.com"}', 'email'),
    (u_email::TEXT, u_email, '{"email": "identities-email@example.com"}', 'email');
  PERFORM set_config('test.u_google', u_google::TEXT, TRUE);
  PERFORM set_config('test.u_hq', u_hq::TEXT, TRUE);
  PERFORM set_config('test.u_both', u_both::TEXT, TRUE);
  PERFORM set_config('test.u_email', u_email::TEXT, TRUE);
END $fixture$;

-- 3. What it returns: google and keycloak identities, three columns, ordered ----

DO $$
DECLARE
  u_google TEXT := current_setting('test.u_google');
  u_hq TEXT := current_setting('test.u_hq');
  u_both TEXT := current_setting('test.u_both');
  u_email TEXT := current_setting('test.u_email');
BEGIN
  ASSERT pg_temp.rows_as('supabase_admin', pg_temp.identities_of(u_google))
    = ARRAY['google/identities-google-sub'], 'a Google sign-in (not its github identity)';
  ASSERT pg_temp.rows_as('supabase_admin', pg_temp.identities_of(u_hq))
    = ARRAY['keycloak/identities-hq-sub'], 'an HQ sign-in';
  ASSERT pg_temp.rows_as('supabase_admin', pg_temp.identities_of(u_both))
    = ARRAY['google/identities-both-sub', 'keycloak/identities-both-sub'],
    'both sign-ins of one person (not the email identity)';
  ASSERT pg_temp.rows_as('supabase_admin', pg_temp.identities_of(u_email)) = '{}'::TEXT[],
    'an email identity names no sign-in sub';

  ASSERT (SELECT count(*) FROM carbon_private.authz_identities())
    = (SELECT count(*) FROM auth.identities AS i WHERE i.provider IN ('google', 'keycloak')),
    'every google and keycloak identity';
  ASSERT NOT EXISTS (SELECT FROM carbon_private.authz_identities() AS i
                     WHERE i.provider NOT IN ('google', 'keycloak')
                        OR i.user_id IS NULL OR i.provider_id IS NULL),
    'nothing else, and no NULLs';
  ASSERT (SELECT array_agg(ARRAY[i.user_id, i.provider, i.provider_id] ORDER BY i.ord)
          FROM carbon_private.authz_identities() WITH ORDINALITY
            AS i(user_id, provider, provider_id, ord))
    = (SELECT array_agg(ARRAY[i.user_id, i.provider, i.provider_id]
                        ORDER BY i.user_id, i.provider, i.provider_id)
       FROM carbon_private.authz_identities() AS i), 'ordered by 1, 2, 3';
END $$;

-- 4. HQ's roles appear: the migration, run again, grants authz_owner alone -------

-- Stand-ins for HQ's tenant roles (deploy/data/tenants.sql): authz_migrator is
-- authz_owner's member; carbon#84 gives authz_api USAGE on carbon_private, so its
-- refusal below comes from EXECUTE, not from the schema.
CREATE ROLE authz_owner NOLOGIN NOINHERIT;
CREATE ROLE authz_migrator NOLOGIN INHERIT IN ROLE authz_owner;
CREATE ROLE authz_api NOLOGIN;
GRANT USAGE ON SCHEMA carbon_private TO authz_api;

DO $$
BEGIN
  PERFORM pg_temp.expect_error('authz_owner',
    'SELECT * FROM carbon_private.authz_identities()', '42501');
END $$;

\ir ../migrations/20261020154924_saturn-authz-identities.sql

DO $$
DECLARE
  fn TEXT := 'carbon_private.authz_identities()';
  owner_name TEXT := (SELECT pg_get_userbyid(p.proowner) FROM pg_proc AS p
                      WHERE p.oid = 'carbon_private.authz_identities()'::REGPROCEDURE);
  r TEXT;
BEGIN
  ASSERT current_user = session_user, 'the migration switched back to the role it started as';
  ASSERT pg_temp.acl() = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[
           'authz_owner=EXECUTE', format('%s=EXECUTE', owner_name)]) AS x),
    format('EXECUTE: the owner and authz_owner only: %s', pg_temp.acl());
  ASSERT has_schema_privilege('authz_owner', 'carbon_private', 'USAGE'), 'authz_owner: USAGE';
  ASSERT has_function_privilege('authz_owner', fn, 'EXECUTE'), 'authz_owner may run it';
  ASSERT has_function_privilege('authz_migrator', fn, 'EXECUTE'),
    'authz_migrator may run it, as authz_owner''s member';
  FOREACH r IN ARRAY ARRAY['authz_api', 'anon', 'authenticated', 'service_role', 'postgres',
                           'supabase_auth_admin', 'carbon_authz_applier'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r AND NOT rolsuper);
    ASSERT NOT has_function_privilege(r, fn, 'EXECUTE'), format('%s may not run it', r);
    PERFORM pg_temp.expect_error(r, 'SELECT * FROM carbon_private.authz_identities()', '42501');
  END LOOP;
  PERFORM set_config('test.acl', pg_temp.acl()::TEXT, TRUE);
  PERFORM set_config('test.src', (SELECT p.prosrc FROM pg_proc AS p
                                  WHERE p.oid = fn::REGPROCEDURE), TRUE);
END $$;

-- Idempotent: a third run changes nothing.
\ir ../migrations/20261020154924_saturn-authz-identities.sql

DO $$
BEGIN
  ASSERT pg_temp.acl()::TEXT = current_setting('test.acl'), 'the grants are unchanged';
  ASSERT (SELECT p.prosrc FROM pg_proc AS p
          WHERE p.oid = 'carbon_private.authz_identities()'::REGPROCEDURE)
    = current_setting('test.src'), 'the body is unchanged';
END $$;

-- 5. Row level security on auth.identities does not reach the reader ------------

-- GoTrue enables row level security on auth.identities and adds no policy (as on
-- HQ's shared database); force it, so even the table's owner would see nothing.
ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.identities FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  u_both TEXT := current_setting('test.u_both');
  both_ids TEXT[] := ARRAY['google/identities-both-sub', 'keycloak/identities-both-sub'];
BEGIN
  ASSERT NOT EXISTS (SELECT FROM pg_policy WHERE polrelid = 'auth.identities'::REGCLASS),
    'no policy on auth.identities';
  ASSERT pg_temp.rows_as('authz_owner', pg_temp.identities_of(u_both)) = both_ids,
    'authz_owner reads identities through the reader';
  ASSERT pg_temp.rows_as('authz_migrator', pg_temp.identities_of(u_both)) = both_ids,
    'and so does authz_migrator';

  -- The retired path: a column grant on GoTrue's table reads zero rows, without
  -- an error. This is why hq-authz's seed skipped every Carbon user.
  GRANT USAGE ON SCHEMA auth TO authz_owner;
  GRANT SELECT (user_id, provider, provider_id) ON auth.identities TO authz_owner;
  ASSERT pg_temp.rows_as('authz_owner', format(
           'SELECT i.provider FROM auth.identities AS i WHERE i.user_id = %L::UUID', u_both))
    = '{}'::TEXT[], 'a column grant reads nothing under row level security';
  REVOKE SELECT (user_id, provider, provider_id) ON auth.identities FROM authz_owner;
  REVOKE USAGE ON SCHEMA auth FROM authz_owner;

  -- The reader still answers for authz_owner, which holds nothing on GoTrue's table.
  ASSERT NOT has_any_column_privilege('authz_owner', 'auth.identities', 'SELECT'),
    'authz_owner holds no grant on auth.identities';
  ASSERT pg_temp.rows_as('authz_owner', pg_temp.identities_of(u_both)) = both_ids,
    'the reader needs no grant on auth.identities';
END $$;

SELECT 'saturn-authz-identities: all checks passed' AS result;
ROLLBACK;
