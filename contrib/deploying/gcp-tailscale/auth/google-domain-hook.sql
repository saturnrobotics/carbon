-- Deployment policy, separate from Carbon's application schema/migrations.
-- Run with psql -X -v ON_ERROR_STOP=1 -v allowed_email_domain=example.com -f ...
-- The value comes from private deployment configuration, never this file.
BEGIN;

CREATE SCHEMA IF NOT EXISTS carbon_private;
REVOKE ALL ON SCHEMA carbon_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA carbon_private TO supabase_auth_admin;

CREATE TABLE IF NOT EXISTS carbon_private.auth_policy (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  allowed_email_domain TEXT NOT NULL CHECK (
    allowed_email_domain = lower(allowed_email_domain)
    AND allowed_email_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  )
);
REVOKE ALL ON carbon_private.auth_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT ON carbon_private.auth_policy TO supabase_auth_admin;
ALTER TABLE carbon_private.auth_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_policy_read ON carbon_private.auth_policy;
CREATE POLICY auth_policy_read ON carbon_private.auth_policy
  FOR SELECT TO supabase_auth_admin USING (TRUE);

INSERT INTO carbon_private.auth_policy (singleton, allowed_email_domain)
VALUES (TRUE, lower(:'allowed_email_domain'))
ON CONFLICT (singleton) DO UPDATE
SET allowed_email_domain = EXCLUDED.allowed_email_domain;

CREATE OR REPLACE FUNCTION carbon_private.google_domain_access_token(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  claims JSONB := event -> 'claims';
  allowed_domain TEXT;
  denied CONSTANT JSONB := '{"error":{"http_code":403,"message":"Sign in with an authorized Google Workspace account."}}'::JSONB;
BEGIN
  SELECT allowed_email_domain INTO allowed_domain
  FROM carbon_private.auth_policy WHERE singleton;

  -- Reject new sessions from email, password, passkeys (Carbon redeems a
  -- magic link for them), invites, anonymous users, SAML, and unknown methods.
  -- Refresh and TOTP are allowed only for a session that began with OAuth.
  IF allowed_domain IS NULL
    OR coalesce(event ->> 'authentication_method', '') NOT IN ('oauth', 'token_refresh', 'totp')
    OR claims ->> 'role' IS DISTINCT FROM 'authenticated'
    OR claims -> 'is_anonymous' IS DISTINCT FROM 'false'::JSONB
    OR event ->> 'user_id' IS DISTINCT FROM claims ->> 'sub'
    OR jsonb_typeof(claims -> 'amr') IS DISTINCT FROM 'array'
  THEN
    RETURN denied;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(claims -> 'amr') AS method
    WHERE method ->> 'method' = 'oauth'
  ) THEN
    RETURN denied;
  END IF;

  -- Do not trust user_metadata: users can change it themselves. identity_data
  -- is populated by GoTrue from Google's validated provider response. The
  -- signed hd claim distinguishes Workspace accounts from consumer Google
  -- accounts that happen to use an address on the same domain.
  -- Google must be the ONLY enabled OAuth provider on this deployment:
  -- Supabase AMR identifies OAuth, but does not identify its provider.
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users AS account
    JOIN auth.identities AS identity ON identity.user_id = account.id
    WHERE account.id::TEXT = event ->> 'user_id'
      AND account.email_confirmed_at IS NOT NULL
      AND lower(account.email) = lower(claims ->> 'email')
      AND split_part(lower(account.email), '@', 2) = allowed_domain
      AND split_part(account.email, '@', 1) <> ''
      AND length(account.email) - length(replace(account.email, '@', '')) = 1
      AND identity.provider = 'google'
      AND lower(identity.identity_data ->> 'email') = lower(account.email)
      AND identity.identity_data -> 'email_verified' = 'true'::JSONB
      AND lower(identity.identity_data #>> '{custom_claims,hd}') = allowed_domain
  ) THEN
    RETURN denied;
  END IF;

  RETURN jsonb_build_object('claims', claims);
END;
$$;

REVOKE ALL ON FUNCTION carbon_private.google_domain_access_token(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION carbon_private.google_domain_access_token(JSONB)
  TO supabase_auth_admin;

COMMIT;
