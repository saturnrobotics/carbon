-- Independently applied knowledge migration.
--
-- Workforce identity enrollment. knowledge."identityBinding" keeps FORCE ROW
-- LEVEL SECURITY with INSERT/UPDATE/DELETE policies of `false` for every runtime
-- role; those are not widened here. The only writers are two SECURITY DEFINER
-- functions owned by a dedicated NOLOGIN, NOBYPASSRLS function-owner role that
-- passes its own policies. Only knowledge_migrate and service_role may execute
-- them; PUBLIC EXECUTE is revoked explicitly after the final ownership change.
--
-- Invariants:
--   * Email is never a subject. A subject must match the IAP shape
--     `accounts.google.com:<numeric id>`; anything containing `@` is refused.
--   * Linking is explicit, never a merge: one (issuer, subject) pair can only
--     ever point at one Carbon user, in any company.
--   * Eligibility is judged by the source-owned resolver the runtime already
--     trusts (public.knowledge_resolve_workforce_identity), because RLS on
--     public."user"/"userToCompany" is JWT-scoped and would hide every row from
--     a NOLOGIN owner. Same pattern as knowledge.actor_active.
--   * revocationVersion starts at 1 on first insert and only ever increases
--     (unbind). Re-enrolling a previously unbound subject reactivates it and
--     bumps `version`, which the resolver folds into permissionsVersion.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='knowledge_enrollment_owner') THEN
    CREATE ROLE knowledge_enrollment_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='knowledge_enrollment_owner'
             AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe knowledge enrollment owner role';
  END IF;
  ALTER ROLE knowledge_enrollment_owner NOINHERIT;
END $$;

-- Requires the source-owned public workforce resolver migration first
-- (20260908005300_knowledge-workforce-identity-resolver.sql).
GRANT USAGE ON SCHEMA public TO knowledge_enrollment_owner;
GRANT EXECUTE ON FUNCTION public.id(text) TO knowledge_enrollment_owner;
GRANT EXECUTE ON FUNCTION public.knowledge_resolve_workforce_identity(text,text,text)
  TO knowledge_enrollment_owner;

-- Temporary membership only so the migrator can hand ownership over.
GRANT knowledge_enrollment_owner TO knowledge_migrate;
SET LOCAL ROLE knowledge_migrate;

GRANT USAGE,CREATE ON SCHEMA knowledge TO knowledge_enrollment_owner;
GRANT SELECT,INSERT,UPDATE ON knowledge."identityBinding" TO knowledge_enrollment_owner;
-- PostgreSQL checks helper execution for every permissive policy on the table,
-- including the runtime SELECT branch, even when the owner's own policy grants
-- the row. Grant only the two boolean helpers that branch references.
GRANT EXECUTE ON FUNCTION knowledge.actor_id(), knowledge.actor_active(text)
  TO knowledge_enrollment_owner;

CREATE POLICY "ENROLLMENT OWNER SELECT" ON knowledge."identityBinding" FOR SELECT
  USING (current_user='knowledge_enrollment_owner');
CREATE POLICY "ENROLLMENT OWNER INSERT" ON knowledge."identityBinding" FOR INSERT
  WITH CHECK (current_user='knowledge_enrollment_owner');
CREATE POLICY "ENROLLMENT OWNER UPDATE" ON knowledge."identityBinding" FOR UPDATE
  USING (current_user='knowledge_enrollment_owner')
  WITH CHECK (current_user='knowledge_enrollment_owner');

CREATE FUNCTION knowledge.enroll_workforce_identity(
  p_issuer text,
  p_subject text,
  p_company_id text,
  p_user_id text,
  p_capabilities text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, knowledge AS $$
DECLARE
  normalized text[];
  binding knowledge."identityBinding";
  resolved jsonb;
BEGIN
  IF p_issuer IS NULL OR p_issuer = '' OR length(p_issuer) > 2048 THEN
    RAISE EXCEPTION 'issuer is required' USING ERRCODE = '22023';
  END IF;
  IF p_company_id IS NULL OR p_company_id = '' OR length(p_company_id) > 2048 THEN
    RAISE EXCEPTION 'company id is required' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL OR p_user_id = '' OR length(p_user_id) > 2048 THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  -- Email is an attribute, never identity. Only the IAP subject shape is bound.
  IF p_subject IS NULL OR position('@' IN p_subject) > 0
     OR p_subject !~ '^accounts\.google\.com:[0-9]+$' THEN
    RAISE EXCEPTION 'subject must be an IAP subject of the form accounts.google.com:<numeric id>; email is never a subject'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT capability ORDER BY capability) INTO normalized
  FROM unnest(p_capabilities) AS capability
  WHERE capability IS NOT NULL AND capability <> '';
  IF normalized IS NULL OR cardinality(normalized) = 0 THEN
    RAISE EXCEPTION 'at least one capability is required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(normalized) AS capability
    WHERE length(capability) > 128 OR capability !~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'
  ) THEN
    RAISE EXCEPTION 'capabilities must be dotted lowercase names such as knowledge.read'
      USING ERRCODE = '22023';
  END IF;

  -- Linking is explicit. The same issuer subject may never point at two users.
  IF EXISTS (
    SELECT 1 FROM knowledge."identityBinding" other
    WHERE other.issuer = p_issuer AND other.subject = p_subject
      AND other."canonicalUserId" <> p_user_id
  ) THEN
    RAISE EXCEPTION 'subject is already bound to a different user for this issuer'
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO binding FROM knowledge."identityBinding" current_binding
  WHERE current_binding."companyId" = p_company_id
    AND current_binding.issuer = p_issuer AND current_binding.subject = p_subject
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO knowledge."identityBinding"
        ("companyId","createdBy",issuer,subject,"canonicalUserId",active,"revocationVersion",capabilities)
      VALUES (p_company_id, p_user_id, p_issuer, p_subject, p_user_id, true, 1, normalized)
      RETURNING * INTO binding;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'user or company does not exist' USING ERRCODE = 'P0002';
    END;
  ELSIF NOT binding.active OR binding.capabilities <> normalized THEN
    UPDATE knowledge."identityBinding" SET
      active = true,
      capabilities = normalized,
      version = version + 1,
      "updatedBy" = p_user_id,
      "updatedAt" = now()
    WHERE id = binding.id AND "companyId" = binding."companyId"
    RETURNING * INTO binding;
  END IF;

  -- The runtime admits only what the resolver reports as fully active. Refuse
  -- (rolling the write back) unless the user exists, is active and currently a
  -- member of an active company.
  resolved := public.knowledge_resolve_workforce_identity(p_issuer, p_subject, p_company_id);
  IF resolved IS NULL
     OR resolved->>'userActive' IS DISTINCT FROM 'true'
     OR resolved->>'membershipActive' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'user must be an active Carbon user with current membership in an active company'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN to_jsonb(binding);
END $$;

CREATE FUNCTION knowledge.unbind_workforce_identity(
  p_issuer text,
  p_subject text,
  p_company_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, knowledge AS $$
DECLARE
  binding knowledge."identityBinding";
BEGIN
  IF p_issuer IS NULL OR p_issuer = '' OR p_subject IS NULL OR p_subject = ''
     OR p_company_id IS NULL OR p_company_id = '' THEN
    RAISE EXCEPTION 'issuer, subject and company id are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO binding FROM knowledge."identityBinding" current_binding
  WHERE current_binding."companyId" = p_company_id
    AND current_binding.issuer = p_issuer AND current_binding.subject = p_subject
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no binding exists for that subject in this company' USING ERRCODE = 'P0002';
  END IF;

  -- Always advance revocationVersion so every cached principal for this binding
  -- is invalidated, even when the binding was already inactive.
  UPDATE knowledge."identityBinding" SET
    active = false,
    "revocationVersion" = "revocationVersion" + 1,
    version = version + 1,
    "updatedBy" = binding."canonicalUserId",
    "updatedAt" = now()
  WHERE id = binding.id AND "companyId" = binding."companyId"
  RETURNING * INTO binding;

  RETURN to_jsonb(binding);
END $$;

ALTER FUNCTION knowledge.enroll_workforce_identity(text,text,text,text,text[])
  OWNER TO knowledge_enrollment_owner;
ALTER FUNCTION knowledge.unbind_workforce_identity(text,text,text)
  OWNER TO knowledge_enrollment_owner;
REVOKE CREATE ON SCHEMA knowledge FROM knowledge_enrollment_owner;
RESET ROLE;
REVOKE knowledge_enrollment_owner FROM knowledge_migrate;

-- Ownership changed, so reset the ACL explicitly: no PUBLIC, no runtime role.
REVOKE ALL ON FUNCTION
  knowledge.enroll_workforce_identity(text,text,text,text,text[]),
  knowledge.unbind_workforce_identity(text,text,text)
  FROM PUBLIC, anon, authenticated, knowledge_read, knowledge_ingest,
  knowledge_review, knowledge_actions, knowledge_maintenance;
GRANT EXECUTE ON FUNCTION
  knowledge.enroll_workforce_identity(text,text,text,text,text[]),
  knowledge.unbind_workforce_identity(text,text,text)
  TO knowledge_migrate;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION
      knowledge.enroll_workforce_identity(text,text,text,text,text[]),
      knowledge.unbind_workforce_identity(text,text,text)
      TO service_role;
  END IF;
END $$;
