-- Saturn fork: Carbon's side of HQ plan 0006B (the central authz service).
--
-- hq-authz decides who may do what in Carbon. This migration adds the receiver
-- that writes authz's projection of each person's permissions into
-- public."userPermission" (the table get_claims, its Redis cache, the RLS helpers
-- and the edge functions already read, so no reader changes), and the lock that
-- stops Carbon's own screens, API, MCP tools, jobs and migrations from editing
-- permissions behind authz's back.
--
-- Everything here is OFF until an operator turns it on, once HQ's C3 gate holds
-- (authz.carbon_permissions equals userPermission for every seeded user):
--
--   UPDATE carbon_private.authz_projection
--      SET enabled = true, hq_origin = 'https://<HQ host>'   -- private value
--    WHERE singleton;
--
-- While enabled is false every writer behaves exactly as before, the receiver
-- refuses to run, and the token hook (contrib/deploying/gcp-tailscale/auth)
-- adds nothing.
--
-- Contract with HQ's schema authz (plan 0006B B4). Carbon calls only these, and
-- only as carbon_authz_applier ("Carbon's applier"), which HQ grants EXECUTE on:
--   authz.subject_of_auth_user(uuid) -> text   'user:<sub>'; NULL if none or disabled
--   authz.carbon_permissions(text)   -> jsonb  {"<module>_<action>": [companyId, ...]}
--   authz.epoch()                    -> bigint
-- Carbon offers authz, through SECURITY DEFINER functions (registered clients may
-- not reach outside their own schema, private-client-isolation.sql):
--   authz_modules(), authz_memberships(), authz_projection_status(),
--   authz_apply_projection(text)
-- The grants below apply when the authz roles already exist; HQ's
-- deploy/data/tenants.sql carries the same lines for databases where they are
-- created later.
--
-- Who owns what:
--   carbon_authz_applier  NOLOGIN, no members. Owns the three functions that call
--                         authz.*, so whatever authz's functions do runs with this
--                         role's privileges (EXECUTE on a few functions here),
--                         never the migration role's.
--   the migration role    Owns everything else, including the only function that
--                         writes userPermission while the lock is on
--                         (authz_write_permissions; EXECUTE: the applier only).
--
-- The lock's "projection path" flag is a row in authz_projection_writer keyed on
-- the current transaction id. Only authz_write_permissions inserts it, and it
-- deletes it before returning. A role that cannot write that table cannot raise
-- it: PostgREST's roles, service_role, and the apps' postgres connection where
-- migrations run as another role (supabase_admin, as in this deployment). A
-- session GUC would not do: any session can set one. Supabase's postgres role
-- does hold CREATEROLE, so code written to grant itself the applier could still
-- get past the lock; as plan 0006B says, fork review is the control there.

-- 1. The applier role ----------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'carbon_authz_applier') THEN
    CREATE ROLE carbon_authz_applier
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS (
    SELECT FROM pg_catalog.pg_roles
    WHERE rolname = 'carbon_authz_applier'
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreatedb OR rolcreaterole
           OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'Unsafe carbon_authz_applier role';
  END IF;
  -- Handing functions to the applier needs a temporary membership, and the
  -- applier needs CREATE on their schema for the transfer; both go at the end.
  EXECUTE pg_catalog.format('GRANT carbon_authz_applier TO %I', current_user);
END $$;

-- 2. Schema --------------------------------------------------------------------

-- Also created by the deployment's token hook (google-domain-hook.sql), which
-- applies the same revocations on every maintenance. Never exposed to PostgREST.
CREATE SCHEMA IF NOT EXISTS carbon_private;
REVOKE ALL ON SCHEMA carbon_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA carbon_private TO postgres, supabase_auth_admin, carbon_authz_applier;
GRANT CREATE ON SCHEMA carbon_private TO carbon_authz_applier;

-- 3. State ---------------------------------------------------------------------

CREATE TABLE carbon_private.authz_projection (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- HQ's origin, for the "managed in HQ" link and messages. Same shape as the
  -- deployment's HQ_ISSUER (https://<host>, no path); set together with enabled.
  hq_origin TEXT CHECK (hq_origin ~ '^https://[a-z0-9]+([.-][a-z0-9]+)*\.[a-z]{2,}$'),
  -- authz.epoch() read at the start of the last completed sync; plan 0006B Q7's
  -- lag alert compares it with authz.epoch().
  synced_epoch BIGINT,
  synced_at TIMESTAMPTZ,
  CONSTRAINT authz_projection_origin_when_enabled CHECK (NOT enabled OR hq_origin IS NOT NULL)
);
INSERT INTO carbon_private.authz_projection (singleton) VALUES (TRUE);

-- The projection path's flag: at most one row per writing transaction, deleted
-- before that transaction can run anything else.
CREATE TABLE carbon_private.authz_projection_writer (
  xact XID8 PRIMARY KEY
);

-- Users whose cached claims (Redis permissions:<uid>) must be deleted. Filled by
-- every projection write, drained by the Inngest job, which acknowledges an
-- entry only after Redis confirmed the delete. A re-queued user gets a new seq,
-- so an acknowledgement for an older seq never drops a newer change.
CREATE SEQUENCE carbon_private.authz_permission_invalidation_seq;
CREATE TABLE carbon_private.authz_permission_invalidation (
  user_id TEXT PRIMARY KEY,
  seq BIGINT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE
  carbon_private.authz_projection,
  carbon_private.authz_projection_writer,
  carbon_private.authz_permission_invalidation
FROM PUBLIC;
REVOKE ALL ON SEQUENCE carbon_private.authz_permission_invalidation_seq FROM PUBLIC;
DO $$
DECLARE
  grantee TEXT;
BEGIN
  -- Only the owner (the migration role) touches these directly.
  FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'postgres',
                                  'supabase_auth_admin']
  LOOP
    CONTINUE WHEN grantee = current_user
      OR NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = grantee);
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE carbon_private.authz_projection,'
      ' carbon_private.authz_projection_writer,'
      ' carbon_private.authz_permission_invalidation FROM %I', grantee);
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON SEQUENCE carbon_private.authz_permission_invalidation_seq FROM %I',
      grantee);
  END LOOP;
END $$;

-- 4. Reads ---------------------------------------------------------------------

-- Is the projection, and with it every lock, on?
CREATE FUNCTION carbon_private.authz_projection_enabled()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT p.enabled FROM carbon_private.authz_projection AS p WHERE p.singleton),
    FALSE
  )
$$;

-- For the apps' "managed in HQ" views and for authz's lag alert.
CREATE FUNCTION carbon_private.authz_projection_status()
RETURNS TABLE (enabled BOOLEAN, access_url TEXT, synced_epoch BIGINT, synced_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p.enabled,
    CASE WHEN p.hq_origin IS NOT NULL THEN p.hq_origin || '/admin/access' END,
    p.synced_epoch,
    p.synced_at
  FROM carbon_private.authz_projection AS p
  WHERE p.singleton
$$;

-- Carbon's module catalog: the live values of public.module, in enum order.
-- authz expands carbon:module.* against it, and projected keys must be
-- "<permission_prefix>_<view|create|update|delete>" for one of these rows.
CREATE FUNCTION carbon_private.authz_modules()
RETURNS TABLE (module TEXT, permission_prefix TEXT, sort_order INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.label::TEXT, lower(m.label::TEXT), m.ord::INTEGER
  FROM unnest(enum_range(NULL::public.module)) WITH ORDINALITY AS m(label, ord)
  ORDER BY m.ord
$$;

-- Company membership, for authz's seed and for /admin/access to say when a grant
-- has no membership to act on (plan 0006B Q4). Membership stays Carbon's.
CREATE FUNCTION carbon_private.authz_memberships()
RETURNS TABLE (
  user_id TEXT,
  email TEXT,
  user_active BOOLEAN,
  company_id TEXT,
  role TEXT,
  employee_type_id TEXT,
  employee_active BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    u.id,
    u.email,
    u.active,
    m."companyId",
    m.role::TEXT,
    e."employeeTypeId",
    e.active
  FROM public."userToCompany" AS m
  JOIN public."user" AS u ON u.id = m."userId"
  LEFT JOIN public.employee AS e ON e.id = m."userId" AND e."companyId" = m."companyId"
  ORDER BY u.id, m."companyId"
$$;

-- Carbon projects every user with a workforce sign-in identity: the providers the
-- token hook admits (google, and keycloak = HQ). Customers, suppliers, console
-- operators and other users without one are never projected (plan 0006B B7);
-- the lock still stops their permissions from being edited.
CREATE FUNCTION carbon_private.authz_is_workforce_user(p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.identities AS i
    WHERE i.user_id::TEXT = p_user_id AND i.provider IN ('google', 'keycloak')
  )
$$;

CREATE FUNCTION carbon_private.authz_workforce_users()
RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id
  FROM public."user" AS u
  WHERE EXISTS (
    SELECT 1 FROM auth.identities AS i
    WHERE i.user_id::TEXT = u.id AND i.provider IN ('google', 'keycloak')
  )
  ORDER BY u.id
$$;

-- 5. Shape ---------------------------------------------------------------------

-- Sorted, de-duplicated company arrays, so equal grants compare equal however
-- authz or an earlier writer ordered them.
CREATE FUNCTION carbon_private.authz_canonical_permissions(p_permissions JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      e.key,
      CASE WHEN jsonb_typeof(e.value) = 'array' THEN (
        SELECT COALESCE(jsonb_agg(DISTINCT v.value ORDER BY v.value), '[]'::JSONB)
        FROM jsonb_array_elements(e.value) AS v(value)
      ) ELSE e.value END
    ),
    '{}'::JSONB
  )
  FROM jsonb_each(
    CASE WHEN jsonb_typeof(p_permissions) = 'object' THEN p_permissions ELSE '{}'::JSONB END
  ) AS e(key, value)
$$;

-- Refuses anything but {"<module>_<action>": ["<companyId>", ...]} over the
-- catalog. Company ids are explicit: the retired "0" wildcard
-- (20260817030612_remove-global-permission-wildcard.sql) and empty ids are
-- refused, never written.
CREATE FUNCTION carbon_private.authz_validated_projection(p_projection JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_entry RECORD;
  v_action TEXT;
  v_prefix TEXT;
  v_company JSONB;
BEGIN
  IF jsonb_typeof(p_projection) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'authz projection for Carbon must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR v_entry IN SELECT e.key, e.value FROM jsonb_each(p_projection) AS e(key, value) LOOP
    v_action := substring(v_entry.key FROM '_(view|create|update|delete)$');
    v_prefix := CASE
      WHEN v_action IS NOT NULL THEN left(v_entry.key, length(v_entry.key) - length(v_action) - 1)
    END;
    IF v_prefix IS NULL OR NOT EXISTS (
      SELECT 1 FROM carbon_private.authz_modules() AS m WHERE m.permission_prefix = v_prefix
    ) THEN
      RAISE EXCEPTION 'authz projection for Carbon has an unknown permission key: %', v_entry.key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_typeof(v_entry.value) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'authz projection for Carbon must list companies for %', v_entry.key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    FOR v_company IN SELECT c.value FROM jsonb_array_elements(v_entry.value) AS c(value) LOOP
      IF jsonb_typeof(v_company) IS DISTINCT FROM 'string'
        OR (v_company #>> '{}') IN ('', '0')
        OR length(v_company #>> '{}') > 128
      THEN
        RAISE EXCEPTION 'authz projection for Carbon names an invalid company for %', v_entry.key
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END LOOP;
  END LOOP;
  RETURN p_projection;
END
$$;

-- 6. Writes (migration role) ---------------------------------------------------

-- The only writer of userPermission while the lock is on. EXECUTE: the applier
-- only. Skips a row that already equals the projection, so a sync rewrites
-- nothing and invalidates nothing when nothing changed.
CREATE FUNCTION carbon_private.authz_write_permissions(p_user_id TEXT, p_permissions JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_next JSONB := carbon_private.authz_canonical_permissions(
    carbon_private.authz_validated_projection(p_permissions)
  );
  v_current JSONB;
  v_found BOOLEAN;
BEGIN
  SELECT p.permissions, TRUE INTO v_current, v_found
  FROM public."userPermission" AS p
  WHERE p.id = p_user_id
  FOR UPDATE;

  IF v_found AND v_current IS NOT NULL
    AND carbon_private.authz_canonical_permissions(v_current) = v_next
  THEN
    RETURN FALSE;
  END IF;

  INSERT INTO carbon_private.authz_projection_writer (xact) VALUES (pg_current_xact_id());
  IF v_found THEN
    UPDATE public."userPermission" AS p SET permissions = v_next WHERE p.id = p_user_id;
  ELSE
    INSERT INTO public."userPermission" (id, permissions) VALUES (p_user_id, v_next);
  END IF;
  DELETE FROM carbon_private.authz_projection_writer AS w WHERE w.xact = pg_current_xact_id();

  INSERT INTO carbon_private.authz_permission_invalidation AS q (user_id, seq)
  VALUES (p_user_id, nextval('carbon_private.authz_permission_invalidation_seq'))
  ON CONFLICT (user_id) DO UPDATE SET seq = EXCLUDED.seq, queued_at = now();
  RETURN TRUE;
END
$$;

CREATE FUNCTION carbon_private.authz_record_sync(p_epoch BIGINT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE carbon_private.authz_projection AS p
  SET synced_epoch = GREATEST(COALESCE(p.synced_epoch, p_epoch), p_epoch),
      synced_at = now()
  WHERE p.singleton
$$;

-- The Inngest job's view of the invalidation queue.
CREATE FUNCTION carbon_private.authz_pending_invalidations(p_limit INTEGER DEFAULT 500)
RETURNS TABLE (user_id TEXT, seq BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT q.user_id, q.seq
  FROM carbon_private.authz_permission_invalidation AS q
  ORDER BY q.seq
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 5000))
$$;

CREATE FUNCTION carbon_private.authz_ack_invalidations(p_seqs BIGINT[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM carbon_private.authz_permission_invalidation AS q WHERE q.seq = ANY (p_seqs);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- 7. The applier's functions (they call authz.*) -------------------------------

-- The projection for one user, or NULL for a user Carbon does not project.
CREATE FUNCTION carbon_private.authz_projection_for(p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_subject TEXT;
  v_projection JSONB;
BEGIN
  IF NOT carbon_private.authz_is_workforce_user(p_user_id) THEN
    RETURN NULL;
  END IF;
  v_subject := authz.subject_of_auth_user(p_user_id::UUID);
  IF v_subject IS NULL THEN
    -- Unknown to HQ, or disabled (make revoke-access): no permissions.
    RETURN '{}'::JSONB;
  END IF;
  v_projection := authz.carbon_permissions(v_subject);
  IF v_projection IS NULL THEN
    RAISE EXCEPTION 'authz.carbon_permissions returned no projection for a registered subject'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN carbon_private.authz_canonical_permissions(
    carbon_private.authz_validated_projection(v_projection)
  );
END
$$;

-- Applies one user's projection; TRUE when the row changed. Refuses while off.
CREATE FUNCTION carbon_private.authz_apply_projection(p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_projection JSONB;
BEGIN
  IF NOT carbon_private.authz_projection_enabled() THEN
    RAISE EXCEPTION 'Carbon''s authz projection is off'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_projection := carbon_private.authz_projection_for(p_user_id);
  IF v_projection IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN carbon_private.authz_write_permissions(p_user_id, v_projection);
END
$$;

-- One sync, run every minute by the Inngest job: every workforce user's row is
-- set to the projection (a no-op for rows that already match). Recomputing every
-- user, rather than only the subjects authz.changes_since names, also catches a
-- person whose identity was linked, or whose Carbon user was created, after the
-- grant that concerns them. Does nothing while off.
CREATE FUNCTION carbon_private.authz_projection_sync()
RETURNS TABLE (applied BOOLEAN, changed INTEGER, epoch BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_epoch BIGINT;
  v_changed INTEGER := 0;
  v_user TEXT;
BEGIN
  IF NOT carbon_private.authz_projection_enabled() THEN
    RETURN QUERY SELECT FALSE, 0, NULL::BIGINT;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('carbon_private.authz_projection_sync'));
  -- Read before applying: every change up to this epoch is in what follows.
  v_epoch := authz.epoch();
  FOR v_user IN SELECT w.id FROM carbon_private.authz_workforce_users() AS w(id) LOOP
    IF carbon_private.authz_apply_projection(v_user) THEN
      v_changed := v_changed + 1;
    END IF;
  END LOOP;
  PERFORM carbon_private.authz_record_sync(v_epoch);
  RETURN QUERY SELECT TRUE, v_changed, v_epoch;
END
$$;

ALTER FUNCTION carbon_private.authz_projection_for(TEXT) OWNER TO carbon_authz_applier;
ALTER FUNCTION carbon_private.authz_apply_projection(TEXT) OWNER TO carbon_authz_applier;
ALTER FUNCTION carbon_private.authz_projection_sync() OWNER TO carbon_authz_applier;

-- 8. The lock ------------------------------------------------------------------

-- While the projection is on, userPermission, employeeType and
-- employeeTypePermission change only through authz_write_permissions:
--   * INSERT into userPermission (GoTrue's create_public_user, a re-created user)
--     is rewritten to the projection: empty for anyone HQ does not know yet; the
--     next sync fills it in once the identity is linked.
--   * UPDATE that changes a row, any other INSERT, and TRUNCATE are refused with
--     SQLSTATE 42501 (PostgREST: 403). That covers the ERP screens, the API and
--     MCP tools, Inngest update-permissions, service_role writes and upstream
--     migrations; the fork re-expresses an upstream permission change as an authz
--     seed change.
--   * DELETE passes: removing a row or a template never grants access, and
--     deleting a user or a company cascades here.
CREATE FUNCTION carbon_private.authz_permission_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_access_url TEXT;
BEGIN
  IF NOT carbon_private.authz_projection_enabled()
    OR EXISTS (
      SELECT 1 FROM carbon_private.authz_projection_writer AS w
      WHERE w.xact = pg_current_xact_id()
    )
  THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW; -- NULL for the statement-level TRUNCATE trigger
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'userPermission' THEN
    NEW.permissions := COALESCE(carbon_private.authz_projection_for(NEW.id), '{}'::JSONB);
    INSERT INTO carbon_private.authz_permission_invalidation AS q (user_id, seq)
    VALUES (NEW.id, nextval('carbon_private.authz_permission_invalidation_seq'))
    ON CONFLICT (user_id) DO UPDATE SET seq = EXCLUDED.seq, queued_at = now();
    RETURN NEW;
  END IF;

  SELECT s.access_url INTO v_access_url FROM carbon_private.authz_projection_status() AS s;
  RAISE EXCEPTION 'Carbon permissions are managed by HQ: % cannot be changed in Carbon',
    TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = COALESCE('Change access at ' || v_access_url || '.', 'Change access in HQ.');
END
$$;

CREATE TRIGGER saturn_authz_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."userPermission"
  FOR EACH ROW EXECUTE FUNCTION carbon_private.authz_permission_guard();
CREATE TRIGGER saturn_authz_permission_guard_truncate
  BEFORE TRUNCATE ON public."userPermission"
  FOR EACH STATEMENT EXECUTE FUNCTION carbon_private.authz_permission_guard();

CREATE TRIGGER saturn_authz_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."employeeType"
  FOR EACH ROW EXECUTE FUNCTION carbon_private.authz_permission_guard();
CREATE TRIGGER saturn_authz_permission_guard_truncate
  BEFORE TRUNCATE ON public."employeeType"
  FOR EACH STATEMENT EXECUTE FUNCTION carbon_private.authz_permission_guard();

CREATE TRIGGER saturn_authz_permission_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."employeeTypePermission"
  FOR EACH ROW EXECUTE FUNCTION carbon_private.authz_permission_guard();
CREATE TRIGGER saturn_authz_permission_guard_truncate
  BEFORE TRUNCATE ON public."employeeTypePermission"
  FOR EACH STATEMENT EXECUTE FUNCTION carbon_private.authz_permission_guard();

-- 9. EXECUTE matrix ------------------------------------------------------------

-- PostgreSQL grants EXECUTE to PUBLIC on every new function, and again after an
-- ownership change, so revoke after the transfer above.
REVOKE ALL ON FUNCTION
  carbon_private.authz_projection_enabled(),
  carbon_private.authz_projection_status(),
  carbon_private.authz_modules(),
  carbon_private.authz_memberships(),
  carbon_private.authz_is_workforce_user(TEXT),
  carbon_private.authz_workforce_users(),
  carbon_private.authz_canonical_permissions(JSONB),
  carbon_private.authz_validated_projection(JSONB),
  carbon_private.authz_write_permissions(TEXT, JSONB),
  carbon_private.authz_record_sync(BIGINT),
  carbon_private.authz_pending_invalidations(INTEGER),
  carbon_private.authz_ack_invalidations(BIGINT[]),
  carbon_private.authz_projection_for(TEXT),
  carbon_private.authz_apply_projection(TEXT),
  carbon_private.authz_projection_sync(),
  carbon_private.authz_permission_guard()
FROM PUBLIC, anon, authenticated, service_role;

-- The applier: what its three functions call.
GRANT EXECUTE ON FUNCTION
  carbon_private.authz_projection_enabled(),
  carbon_private.authz_modules(),
  carbon_private.authz_is_workforce_user(TEXT),
  carbon_private.authz_workforce_users(),
  carbon_private.authz_canonical_permissions(JSONB),
  carbon_private.authz_validated_projection(JSONB),
  carbon_private.authz_write_permissions(TEXT, JSONB),
  carbon_private.authz_record_sync(BIGINT)
TO carbon_authz_applier;

-- The apps' own connection: the "managed in HQ" views, the Inngest job, and the
-- guard where the migration role is not a superuser.
GRANT EXECUTE ON FUNCTION
  carbon_private.authz_projection_enabled(),
  carbon_private.authz_projection_status(),
  carbon_private.authz_projection_for(TEXT),
  carbon_private.authz_apply_projection(TEXT),
  carbon_private.authz_projection_sync(),
  carbon_private.authz_pending_invalidations(INTEGER),
  carbon_private.authz_ack_invalidations(BIGINT[])
TO postgres;

-- The token hook (supabase_auth_admin) reads only whether the lock is on.
GRANT EXECUTE ON FUNCTION carbon_private.authz_projection_enabled() TO supabase_auth_admin;

-- hq-authz (plan 0006B B4): authz_owner owns authz.carbon_permissions, which
-- expands modules from the catalog; authz_migrator (a member) seeds from
-- membership and may apply after the C3 gate; authz_api serves /admin/access.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authz_owner') THEN
    GRANT USAGE ON SCHEMA carbon_private TO authz_owner;
    GRANT EXECUTE ON FUNCTION
      carbon_private.authz_modules(),
      carbon_private.authz_memberships(),
      carbon_private.authz_projection_status(),
      carbon_private.authz_apply_projection(TEXT)
    TO authz_owner;
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authz_api') THEN
    GRANT USAGE ON SCHEMA carbon_private TO authz_api;
    GRANT EXECUTE ON FUNCTION
      carbon_private.authz_memberships(),
      carbon_private.authz_projection_status()
    TO authz_api;
  END IF;
END $$;

-- 10. Drop the temporary privileges ---------------------------------------------

REVOKE CREATE ON SCHEMA carbon_private FROM carbon_authz_applier;
DO $$
BEGIN
  EXECUTE pg_catalog.format('REVOKE carbon_authz_applier FROM %I', current_user);
  -- Whoever can SET ROLE to the applier can call authz_write_permissions.
  IF EXISTS (
    SELECT FROM pg_catalog.pg_auth_members
    WHERE roleid = 'carbon_authz_applier'::REGROLE
  ) THEN
    RAISE EXCEPTION 'carbon_authz_applier must have no members';
  END IF;
END $$;
