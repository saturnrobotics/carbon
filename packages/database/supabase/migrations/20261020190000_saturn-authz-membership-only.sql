-- Saturn fork: lets Carbon's membership flows run while HQ manages permissions
-- (HQ plan 0006B B7; follows 20261018214537_saturn-authz-projection.sql).
--
-- While carbon_private.authz_projection.enabled is true, the guards refuse every
-- write to employeeType. But public.employee."employeeTypeId" is NOT NULL, so a
-- company could not get its first employee, and console mode could not get the
-- "Console Operator" type its operators are created with. Membership (userToCompany,
-- employee) stays Carbon's (plan 0006B Q4), so this adds one narrow writer:
--
--   carbon_private.authz_ensure_system_employee_type(company_id, system_type) -> text
--
-- It returns the company's employee type for a system type ('Admin' or
-- 'Console Operator'), creating it if missing: name = the system type, protected,
-- and NO template rows in employeeTypePermission. A type row is a label that
-- membership points at; it grants nothing, because while HQ manages permissions
-- userPermission holds only HQ's projection. It never writes userPermission or
-- employeeTypePermission, and refuses if anything (an upstream trigger, say) wrote
-- template rows for the new type in the same statement.
--
-- Callers use it only while the projection is enabled (seed-company, console mode);
-- while it is off they keep upstream's writes. It works in both states, so a flip
-- between the caller's read and its call cannot fail the flow. EXECUTE: postgres,
-- the apps' and edge functions' own connection, only.
--
-- It raises the projection path's flag (a row in authz_projection_writer keyed on
-- the transaction) only around its one INSERT, as authz_write_permissions does,
-- and deletes it before returning.

-- 0. Run as the database administrator -------------------------------------------

-- carbon_private belongs to the administrator (see the projection migration's
-- section 0): postgres, which the Supabase CLI migrates as, cannot create objects
-- in it. When the session user is a superuser, run as it, and switch back at the end.
DO $$
BEGIN
  PERFORM pg_catalog.set_config('carbon_private.migration_role', current_user, false);
  IF session_user <> current_user
    AND (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user)
  THEN
    PERFORM pg_catalog.set_config('role', session_user, false);
  END IF;
END $$;

-- 1. The writer ------------------------------------------------------------------

CREATE FUNCTION carbon_private.authz_ensure_system_employee_type(
  p_company_id TEXT,
  p_system_type TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_system_type public."employeeTypeSystemType";
  v_id TEXT;
BEGIN
  IF p_company_id IS NULL OR p_system_type IS NULL THEN
    RAISE EXCEPTION 'a company and a system employee type are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 'Admin' or 'Console Operator'; anything else raises 22P02.
  v_system_type := p_system_type::public."employeeTypeSystemType";

  SELECT et.id INTO v_id
  FROM public."employeeType" AS et
  WHERE et."companyId" = p_company_id AND et."systemType" = v_system_type;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO carbon_private.authz_projection_writer (xact) VALUES (pg_current_xact_id());
  INSERT INTO public."employeeType" (name, "companyId", protected, "systemType")
  VALUES (v_system_type::TEXT, p_company_id, TRUE, v_system_type)
  ON CONFLICT ("companyId", "systemType") WHERE "systemType" IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  DELETE FROM carbon_private.authz_projection_writer AS w WHERE w.xact = pg_current_xact_id();

  IF v_id IS NULL THEN
    -- A concurrent transaction created it first.
    SELECT et.id INTO v_id
    FROM public."employeeType" AS et
    WHERE et."companyId" = p_company_id AND et."systemType" = v_system_type;
    RETURN v_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public."employeeTypePermission" AS p WHERE p."employeeTypeId" = v_id
  ) THEN
    RAISE EXCEPTION 'Carbon permissions are managed by HQ: a new employee type must carry no permissions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_id;
END
$$;

-- 2. EXECUTE matrix ------------------------------------------------------------

REVOKE ALL ON FUNCTION carbon_private.authz_ensure_system_employee_type(TEXT, TEXT)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION carbon_private.authz_ensure_system_employee_type(TEXT, TEXT)
TO postgres;

-- 3. Back to the role the migration tool chose --------------------------------

DO $$
BEGIN
  PERFORM pg_catalog.set_config(
    'role', current_setting('carbon_private.migration_role'), false);
END $$;
