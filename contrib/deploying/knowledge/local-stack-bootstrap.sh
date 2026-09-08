#!/bin/sh
set -eu

database_url=${KNOWLEDGE_E2E_DATABASE_URL:?required}
repository=${KNOWLEDGE_REPOSITORY_ROOT:-/repo}
expected_url=postgresql://supabase_admin:synthetic-test-only@postgres:5432/knowledge_test
if [ "$database_url" != "$expected_url" ]; then
  echo "Refusing a database outside the fixed local Docker fixture" >&2
  exit 1
fi

case "${1:-}" in
  bootstrap)
    psql "$database_url" -X -v ON_ERROR_STOP=1 <<'SQL'
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
    psql "$database_url" -X -v ON_ERROR_STOP=1 \
      -f "$repository/packages/knowledge/scripts/bootstrap-test.sql"
    psql "$database_url" -X -v ON_ERROR_STOP=1 \
      -f "$repository/packages/database/supabase/migrations/20260908005300_knowledge-workforce-identity-resolver.sql"
    ;;
  fixture)
    psql "$database_url" -X -v ON_ERROR_STOP=1 \
      -f "$repository/packages/database/supabase/migrations/20260908012959_knowledge-function-execution-boundary.sql"
    psql "$database_url" -X -v ON_ERROR_STOP=1 \
      -f "$repository/packages/knowledge/scripts/policy-fixtures.sql"
    psql "$database_url" -X -v ON_ERROR_STOP=1 \
      -f "$repository/contrib/deploying/knowledge/local-stack-fixture.sql"
    ;;
  *)
    echo "usage: local-stack-bootstrap.sh bootstrap|fixture" >&2
    exit 2
    ;;
esac
