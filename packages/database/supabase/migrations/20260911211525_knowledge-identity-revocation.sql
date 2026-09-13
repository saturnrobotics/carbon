-- Knowledge identity revocation propagation.
--
-- Carbon owns the two facts the knowledge platform derives admission from:
-- public."user".active and public."userToCompany" membership. The runtime
-- already refuses a deactivated user or a removed membership on the next
-- request (public.knowledge_resolve_workforce_identity reports userActive and
-- membershipActive; identity.server.ts rejects either), but nothing advanced
-- knowledge."identityBinding"."revocationVersion" -- the component of every
-- cached principal's policyVersion and of the answer-cache policy snapshot
-- (cache/epochs.server.ts). These triggers make both facts revoke the binding
-- itself: active=false and revocationVersion+1 on every binding of the user --
-- in every company on deactivation, in the one company on membership removal.
-- Re-activating the user does not re-enable a binding; enrollment is explicit.
--
-- Deliberately NOT added: a bump on UPDATE OF permissions ON "userPermission".
-- permissionsVersion (identity version || md5(permissions) in the resolver)
-- already changes on every permission edit, so a cached principal is
-- invalidated without a second mechanism.
--
-- Installs without the knowledge platform: the trigger function is owned by
-- knowledge_enrollment_owner -- created here with the same NOLOGIN, NOBYPASSRLS
-- shape when the private enrollment migration has not run yet -- and returns
-- before touching anything while knowledge."identityBinding" does not exist.
-- The documented order applies Carbon migrations before the private knowledge
-- migrations, so an install-time guard would silently skip this on every fresh
-- install; the guard is therefore evaluated when the trigger fires. The owner
-- role's table grants and RLS policies come from the knowledge enrollment
-- migration (packages/knowledge/migrations/20260911204358_*), so once that has
-- run the triggers work with no further step. If the binding table exists but
-- those grants are missing, the trigger refuses loudly rather than skipping.
--
-- app.sync_in_progress is deliberately not honoured: any session can set that
-- GUC, and a revocation must not be suppressible.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'knowledge_enrollment_owner') THEN
    CREATE ROLE knowledge_enrollment_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'knowledge_enrollment_owner'
             AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe knowledge enrollment owner role';
  END IF;
  -- Supabase applies migrations as a non-superuser role. Handing ownership
  -- over needs a temporary membership in the owner role, and the owner needs
  -- CREATE on the function's schema for the transfer; both are removed below.
  EXECUTE format('GRANT knowledge_enrollment_owner TO %I', current_user);
END $$;
GRANT CREATE ON SCHEMA public TO knowledge_enrollment_owner;

CREATE OR REPLACE FUNCTION public.knowledge_propagate_identity_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, knowledge
AS $$
DECLARE
  target_user text;
  target_company text;
BEGIN
  IF to_regclass('knowledge."identityBinding"') IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'user' THEN
    target_user := NEW.id;
  ELSIF TG_TABLE_NAME = 'userToCompany' THEN
    target_user := OLD."userId";
    target_company := OLD."companyId";
  ELSE
    RAISE EXCEPTION 'knowledge_propagate_identity_revocation is attached to an unexpected table: %', TG_TABLE_NAME;
  END IF;

  BEGIN
    -- Always advance revocationVersion, even on an already inactive binding,
    -- so every cached principal for it is invalidated (same rule as
    -- knowledge.unbind_workforce_identity). The version bump satisfies the
    -- binding table's knowledge.check_version trigger.
    UPDATE knowledge."identityBinding" SET
      active = false,
      "revocationVersion" = "revocationVersion" + 1,
      version = version + 1,
      "updatedBy" = target_user,
      "updatedAt" = now()
    WHERE "canonicalUserId" = target_user
      AND (target_company IS NULL OR "companyId" = target_company);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'knowledge identity revocation could not propagate: apply the knowledge enrollment migration that grants knowledge_enrollment_owner its binding access'
      USING ERRCODE = '42501';
  END;

  RETURN NULL;
END $$;

ALTER FUNCTION public.knowledge_propagate_identity_revocation()
  OWNER TO knowledge_enrollment_owner;
REVOKE CREATE ON SCHEMA public FROM knowledge_enrollment_owner;
-- Trigger functions fire without an EXECUTE check on the writing role, so no
-- role needs a grant; materialise an ACL with no PUBLIC entry.
REVOKE ALL ON FUNCTION public.knowledge_propagate_identity_revocation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS knowledge_identity_revocation_on_user_deactivation ON public."user";
CREATE TRIGGER knowledge_identity_revocation_on_user_deactivation
  AFTER UPDATE OF active ON public."user"
  FOR EACH ROW
  WHEN (COALESCE(OLD.active, false) AND NOT COALESCE(NEW.active, false))
  EXECUTE FUNCTION public.knowledge_propagate_identity_revocation();

DROP TRIGGER IF EXISTS knowledge_identity_revocation_on_membership_removal ON public."userToCompany";
CREATE TRIGGER knowledge_identity_revocation_on_membership_removal
  AFTER DELETE ON public."userToCompany"
  FOR EACH ROW
  EXECUTE FUNCTION public.knowledge_propagate_identity_revocation();

-- The triggers exist and the function is owned; drop the temporary membership.
DO $$ BEGIN
  EXECUTE format('REVOKE knowledge_enrollment_owner FROM %I', current_user);
END $$;
