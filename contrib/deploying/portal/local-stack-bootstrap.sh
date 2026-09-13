#!/bin/sh
set -eu

database_url=${PORTAL_E2E_DATABASE_URL:?required}
repository=${PORTAL_REPOSITORY_ROOT:-/repo}
expected_url=postgresql://supabase_admin:synthetic-test-only@postgres:5432/portal_test
if [ "$database_url" != "$expected_url" ]; then
  echo "Refusing a database outside the fixed local Docker fixture" >&2
  exit 1
fi

case "${1:-}" in
  bootstrap)
    psql "$database_url" -X -1 -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END $$;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
SQL
    psql "$database_url" -X -1 -v ON_ERROR_STOP=1 \
      -f "$repository/packages/portal/scripts/bootstrap-test.sql"
    if [ "$(psql "$database_url" -XAt -v ON_ERROR_STOP=1 -c "SELECT to_regprocedure('public.portal_resolve_workforce_identity(text,text,text)') IS NOT NULL")" != "t" ]; then
    psql "$database_url" -X -1 -v ON_ERROR_STOP=1 \
      -f "$repository/packages/database/supabase/migrations/20260908005300_knowledge-workforce-identity-resolver.sql"
    psql "$database_url" -X -1 -v ON_ERROR_STOP=1 \
      -f "$repository/packages/database/supabase/migrations/20260911211525_knowledge-identity-revocation.sql"
    psql "$database_url" -X -1 -v ON_ERROR_STOP=1 \
      -f "$repository/packages/database/supabase/migrations/20260908012959_knowledge-function-execution-boundary.sql"
    psql "$database_url" -X -1 -v ON_ERROR_STOP=1 \
      -f "$repository/packages/database/supabase/migrations/20260913192022_portal-public-identifiers.sql"
    fi
    ;;
  fixture)
    psql "$database_url" -X -1 -v ON_ERROR_STOP=1 \
      -f "$repository/packages/portal/scripts/policy-fixtures.sql"
    psql "$database_url" -X -1 -v ON_ERROR_STOP=1 \
      -f "$repository/contrib/deploying/portal/local-stack-fixture.sql"
    ;;
  *)
    echo "usage: local-stack-bootstrap.sh bootstrap|fixture" >&2
    exit 2
    ;;
esac
