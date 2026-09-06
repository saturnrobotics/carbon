-- Enforce the schema boundary for separately provisioned database clients.
-- The deployment administrator owns carbon_private.database_clients:
--   (role_name TEXT PRIMARY KEY, schema_name TEXT NOT NULL).
-- Deployments without registered clients retain their existing privileges.
BEGIN;

DO $isolate$
DECLARE
  client RECORD;
  namespace RECORD;
  legacy_role RECORD;
  privilege TEXT;
  database_name TEXT := current_database();
BEGIN
  IF to_regclass('carbon_private.database_clients') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM carbon_private.database_clients) THEN
    RETURN;
  END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Private client isolation requires the deployment administrator';
  END IF;

  FOR client IN SELECT * FROM carbon_private.database_clients LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles r
      WHERE r.rolname = client.role_name
        AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
                 OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
        AND r.rolname !~ '^pg_'
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid)
    ) THEN
      RAISE EXCEPTION 'Registered database client has unsafe role privileges';
    END IF;
    IF client.schema_name IN ('public', 'carbon_private', 'information_schema')
       OR client.schema_name ~ '^pg_'
       OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = client.schema_name)
       OR NOT has_schema_privilege(client.role_name, client.schema_name, 'USAGE') THEN
      RAISE EXCEPTION 'Registered database client has an invalid application schema';
    END IF;
  END LOOP;

  -- A role-specific REVOKE cannot override PUBLIC. Preserve existing service
  -- privileges explicitly before removing the implicit grant to every login.
  -- Do not grant privileges to PostgreSQL's built-in membership roles.
  FOR namespace IN
    SELECT oid, nspname, nspacl, nspowner FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
  LOOP
    FOREACH privilege IN ARRAY ARRAY['USAGE', 'CREATE'] LOOP
      IF EXISTS (
        SELECT 1 FROM aclexplode(coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))) a
        WHERE a.grantee = 0 AND a.privilege_type = privilege
      ) THEN
        FOR legacy_role IN
          SELECT r.rolname FROM pg_roles r
          WHERE r.rolname !~ '^pg_' AND NOT r.rolsuper
            AND NOT EXISTS (
              SELECT 1 FROM carbon_private.database_clients c WHERE c.role_name = r.rolname
            )
            AND has_schema_privilege(r.oid, namespace.oid, privilege)
        LOOP
          EXECUTE format('GRANT %s ON SCHEMA %I TO %I', privilege, namespace.nspname, legacy_role.rolname);
        END LOOP;
        EXECUTE format('REVOKE %s ON SCHEMA %I FROM PUBLIC', privilege, namespace.nspname);
      END IF;
    END LOOP;
  END LOOP;

  -- TEMP could shadow unqualified relations inside a SECURITY DEFINER function.
  -- CREATE would let a client add schemas or trusted extensions to this database.
  FOREACH privilege IN ARRAY ARRAY['TEMPORARY', 'CREATE'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_database d,
        LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      WHERE d.datname = database_name AND a.grantee = 0 AND a.privilege_type = privilege
    ) THEN
      FOR legacy_role IN
        SELECT r.rolname FROM pg_roles r
        WHERE r.rolname !~ '^pg_' AND NOT r.rolsuper
          AND NOT EXISTS (
            SELECT 1 FROM carbon_private.database_clients c WHERE c.role_name = r.rolname
          )
          AND has_database_privilege(r.oid, database_name, privilege)
      LOOP
        EXECUTE format('GRANT %s ON DATABASE %I TO %I', privilege, database_name, legacy_role.rolname);
      END LOOP;
      EXECUTE format('REVOKE %s ON DATABASE %I FROM PUBLIC', privilege, database_name);
    END IF;
  END LOOP;

  FOR client IN SELECT * FROM carbon_private.database_clients LOOP
    IF has_database_privilege(client.role_name, database_name, 'TEMPORARY')
       OR has_database_privilege(client.role_name, database_name, 'CREATE')
       OR EXISTS (
         SELECT 1 FROM pg_namespace n
         WHERE (n.nspname <> client.schema_name
                AND has_schema_privilege(client.role_name, n.oid, 'CREATE'))
           OR (n.nspname NOT IN (client.schema_name, 'pg_catalog', 'information_schema')
               AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_'
               AND has_schema_privilege(client.role_name, n.oid, 'USAGE'))
       ) THEN
      RAISE EXCEPTION 'Registered database client can access another application schema or create temporary objects';
    END IF;
  END LOOP;
END
$isolate$;

COMMIT;
