-- Saturn fork: Carbon's sign-in identities for HQ's authz service (HQ plan 0006B
-- B4 and B10), a follow-up to 20261018214537_saturn-authz-projection.sql.
--
-- hq-authz finds the person behind a Carbon user through the user's GoTrue
-- sign-in identity: authz.subject_of_auth_user(uuid), which the projection
-- receiver (authz_projection_for) and the token hook call, and its seed and C3
-- gate, which register every Carbon user. Until now both read auth.identities
-- through a column grant to authz_owner. GoTrue's auth.identities has row level
-- security on and no policy, so that grant read zero rows without an error: the
-- seed skipped every user, and once enabled the projection would have given
-- every person '{}'.
--
-- authz_identities() is the reader authz uses instead, in the pattern of
-- 20261018214537's readers: SECURITY DEFINER, owned by the administrator (row
-- level security does not apply to a superuser), STABLE, search_path '', and
-- EXECUTE for authz_owner only (authz_migrator reaches it as its member;
-- authz_api never does).
--
--   authz_identities() -> (user_id text, provider text, provider_id text)
--     the providers the token hook admits for the workforce, ordered by
--     user_id, provider, provider_id:
--       google    provider_id is Google's sub
--       keycloak  an HQ sign-in; provider_id is HQ's sub, which is the same
--                 Google sub (HQ plan 0013)
--
-- Nothing else of an identity (identity_data, email, timestamps) is returned,
-- and no other provider's identities are.
--
-- The grant is guarded: it applies only where HQ's role authz_owner exists (HQ's
-- shared database), so Carbon's own local and CI stacks migrate as before. HQ's
-- deploy/data/tenants.sql carries the same DO block verbatim for databases where
-- authz_owner appears after this migration ran; change both repositories
-- together, never one. Idempotent: running the file again changes nothing.

-- 0. Run as the database administrator -------------------------------------------

-- As in 20261018214537 (section 0): the Supabase CLI connects as supabase_admin
-- but applies migrations under SET SESSION ROLE postgres, which cannot create
-- objects in the administrator's carbon_private and must not own a reader of
-- GoTrue's table. So when the session user is a superuser, this file runs as it,
-- and section 3 switches back to the role the CLI chose.
DO $$
BEGIN
  PERFORM pg_catalog.set_config('carbon_private.migration_role', current_user, false);
  IF session_user <> current_user
    AND (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user)
  THEN
    PERFORM pg_catalog.set_config('role', session_user, false);
  END IF;
END $$;

-- 1. The reader ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION carbon_private.authz_identities()
RETURNS TABLE (user_id TEXT, provider TEXT, provider_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.user_id::TEXT, i.provider::TEXT, i.provider_id::TEXT
  FROM auth.identities AS i
  WHERE i.provider IN ('google', 'keycloak')
  ORDER BY 1, 2, 3
$$;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function.
REVOKE ALL ON FUNCTION carbon_private.authz_identities()
FROM PUBLIC, anon, authenticated, service_role;

-- 2. hq-authz (HQ plan 0006B B4): authz_owner only --------------------------------

-- HQ's deploy/data/tenants.sql carries this block verbatim.
DO $authz_identities$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authz_owner')
    OR pg_catalog.to_regprocedure('carbon_private.authz_identities()') IS NULL
  THEN
    RETURN;
  END IF;

  GRANT USAGE ON SCHEMA carbon_private TO authz_owner;
  GRANT EXECUTE ON FUNCTION carbon_private.authz_identities() TO authz_owner;
END
$authz_identities$;

-- 3. Back to the role the migration tool chose --------------------------------

DO $$
BEGIN
  PERFORM pg_catalog.set_config(
    'role', current_setting('carbon_private.migration_role'), false);
END $$;
