-- Resolve a provisioned workforce subject to an existing Carbon user without
-- exposing email or allowing browser/authenticated clients to enumerate bindings.
DO $roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['knowledge_read', 'knowledge_migrate'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT',
        role_name
      );
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = role_name
        AND (rolsuper OR rolbypassrls OR rolcanlogin)
    ) THEN
      RAISE EXCEPTION 'Unsafe knowledge runtime role: %', role_name;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE member_role.rolname = role_name
    ) THEN
      RAISE EXCEPTION 'Knowledge runtime role inherits another role: %', role_name;
    END IF;
    EXECUTE format('ALTER ROLE %I NOINHERIT', role_name);
  END LOOP;
END
$roles$;

CREATE OR REPLACE FUNCTION public.knowledge_resolve_workforce_identity(
  requested_issuer text,
  requested_subject text,
  requested_company_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  binding jsonb;
BEGIN
  EXECUTE $query$
    SELECT jsonb_build_object(
      'actorId', identity."canonicalUserId",
      'companyId', identity."companyId",
      'companyGroupId', COALESCE(company."companyGroupId", company.id),
      'bindingActive', identity.active,
      'userActive', COALESCE(app_user.active, false),
      'membershipActive', membership."userId" IS NOT NULL AND company.active,
      'revocationVersion', identity."revocationVersion",
      'permissionsVersion',
        identity.version::text || ':' ||
        md5(COALESCE(permission.permissions::text, '{}')),
      'capabilities', to_jsonb(identity.capabilities)
    )
    FROM knowledge."identityBinding" AS identity
    JOIN public.company AS company
      ON company.id = identity."companyId"
    JOIN public."user" AS app_user
      ON app_user.id = identity."canonicalUserId"
    LEFT JOIN public."userToCompany" AS membership
      ON membership."userId" = identity."canonicalUserId"
     AND membership."companyId" = identity."companyId"
    LEFT JOIN public."userPermission" AS permission
      ON permission.id = identity."canonicalUserId"
    WHERE identity.issuer = $1
      AND identity.subject = $2
      AND identity."companyId" = $3
    LIMIT 1
  $query$
  INTO binding
  USING requested_issuer, requested_subject, requested_company_id;

  RETURN binding;
END
$function$;

REVOKE ALL ON FUNCTION public.knowledge_resolve_workforce_identity(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_resolve_workforce_identity(text, text, text)
  TO service_role, knowledge_read, knowledge_migrate;
