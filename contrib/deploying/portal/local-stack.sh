#!/bin/sh
set -eu

directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository=$(CDPATH='' cd -- "$directory/../../.." && pwd)
compose_file="$directory/compose.local.yaml"

# Stack name, image tag and published loopback ports are overridable so a second
# stack can run beside one that is already up, with its own volumes. CI leaves
# all of them unset and gets the historical project name, `manual-v1` tags and
# the fixed ports, so an unparameterised invocation is unchanged.
PORTAL_LOCAL_STACK=${PORTAL_LOCAL_STACK:-portal-manual-local}
PORTAL_LOCAL_TAG=${PORTAL_LOCAL_TAG:-manual-v1}
PORTAL_LOCAL_WEB_PORT=${PORTAL_LOCAL_WEB_PORT:-4200}
PORTAL_LOCAL_GATEWAY_PORT=${PORTAL_LOCAL_GATEWAY_PORT:-4301}
PORTAL_LOCAL_QUERY_PORT=${PORTAL_LOCAL_QUERY_PORT:-4302}
PORTAL_LOCAL_DRIVE_GATEWAY_PORT=${PORTAL_LOCAL_DRIVE_GATEWAY_PORT:-4303}
PORTAL_LOCAL_DRIVE_QUERY_PORT=${PORTAL_LOCAL_DRIVE_QUERY_PORT:-4304}
PORTAL_LOCAL_DATABASE_PORT=${PORTAL_LOCAL_DATABASE_PORT:-59910}
PORTAL_LOCAL_REDIS_PORT=${PORTAL_LOCAL_REDIS_PORT:-59911}
PORTAL_LOCAL_STORAGE_PORT=${PORTAL_LOCAL_STORAGE_PORT:-59912}
PORTAL_LOCAL_INNGEST_PORT=${PORTAL_LOCAL_INNGEST_PORT:-59914}
export PORTAL_LOCAL_STACK PORTAL_LOCAL_TAG \
  PORTAL_LOCAL_WEB_PORT PORTAL_LOCAL_GATEWAY_PORT \
  PORTAL_LOCAL_QUERY_PORT PORTAL_LOCAL_DRIVE_GATEWAY_PORT \
  PORTAL_LOCAL_DRIVE_QUERY_PORT PORTAL_LOCAL_DATABASE_PORT \
  PORTAL_LOCAL_REDIS_PORT PORTAL_LOCAL_STORAGE_PORT \
  PORTAL_LOCAL_INNGEST_PORT

compose() {
  docker compose -p "$PORTAL_LOCAL_STACK" -f "$compose_file" "$@"
}

wait_http() {
  url=$1
  attempts=${2:-60}
  while [ "$attempts" -gt 0 ]; do
    if curl --fail --silent --show-error --insecure "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 1
  done
  echo "Timed out waiting for $url" >&2
  return 1
}

wait_service_health() {
  service=$1
  attempts=${2:-60}
  while [ "$attempts" -gt 0 ]; do
    container_id=$(compose ps -q "$service")
    if [ -n "$container_id" ] &&
      [ "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = healthy ]; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 1
  done
  echo "Timed out waiting for $service health" >&2
  return 1
}

start() {
  compose up -d postgres redis storage
  wait_service_health postgres 90
  wait_service_health redis 90
  compose run --rm bootstrap
  compose run --rm schema
  compose run --rm fixture
  compose up -d parser ingest inngest query drive portal
  wait_http "http://127.0.0.1:$PORTAL_LOCAL_GATEWAY_PORT/health" 120
  wait_http "http://127.0.0.1:$PORTAL_LOCAL_QUERY_PORT/health" 120
  wait_http "http://127.0.0.1:$PORTAL_LOCAL_DRIVE_GATEWAY_PORT/health" 120
  wait_http "http://127.0.0.1:$PORTAL_LOCAL_DRIVE_QUERY_PORT/health" 120
  wait_http "http://127.0.0.1:$PORTAL_LOCAL_INNGEST_PORT/" 120
  wait_http "https://127.0.0.1:$PORTAL_LOCAL_WEB_PORT/" 120
  echo "Portal manual stack is ready at https://localhost:$PORTAL_LOCAL_WEB_PORT"
}

case "${1:-up}" in
  up)
    start
    ;;
  test)
    start
    database_container=$(compose ps -q postgres)
    fixture_before=$(docker exec -i -e PGPASSWORD=synthetic-test-only "$database_container" \
      psql -X -At -v ON_ERROR_STOP=1 -U supabase_admin -d portal_test <<'SQL'
SELECT jsonb_build_object(
  'intakes', (SELECT coalesce(jsonb_agg(id), '[]'::jsonb)
    FROM portal.intake WHERE "companyId" = 'company-b'),
  'documents', (SELECT coalesce(jsonb_agg(id), '[]'::jsonb)
    FROM portal.document WHERE "companyId" = 'company-b'
      AND "sourceId" = 'source-b' AND "sourceItemId" LIKE 'intake:%')
)
SQL
    )
    PORTAL_E2E_BASE_URL="https://localhost:$PORTAL_LOCAL_WEB_PORT" \
    PORTAL_E2E_DATABASE_CONTAINER=$database_container \
    PORTAL_E2E_DATABASE_PORT="$PORTAL_LOCAL_DATABASE_PORT" \
    PORTAL_E2E_DATABASE_URL="postgresql://supabase_admin:synthetic-test-only@127.0.0.1:$PORTAL_LOCAL_DATABASE_PORT/portal_test" \
    PORTAL_E2E_GATEWAY_URL="http://127.0.0.1:$PORTAL_LOCAL_GATEWAY_PORT" \
    PORTAL_E2E_QUERY_FIXTURE_URL="http://127.0.0.1:$PORTAL_LOCAL_QUERY_PORT" \
    PORTAL_E2E_DRIVE_GATEWAY_URL="http://127.0.0.1:$PORTAL_LOCAL_DRIVE_GATEWAY_PORT" \
    PORTAL_E2E_DRIVE_QUERY_URL="http://127.0.0.1:$PORTAL_LOCAL_DRIVE_QUERY_PORT" \
    PORTAL_E2E_SYNTHETIC_FIXTURES=1 \
      corepack pnpm --dir "$repository" --filter portal test:e2e
    preserve=0
    if [ "${PORTAL_E2E_PRESERVE_FIXTURE:-}" = "1" ]; then
      preserve=1
    fi
    docker exec -i -e PGPASSWORD=synthetic-test-only "$database_container" \
      psql -X -U supabase_admin -d portal_test --set="preserve=$preserve" \
      --set="before=$fixture_before" \
      < "$directory/verify-local-fixtures.sql"
    ;;
  status)
    compose ps
    ;;
  logs)
    if [ "$#" -gt 1 ]; then
      compose logs --tail=200 "$2"
    else
      compose logs --tail=200
    fi
    ;;
  stop)
    compose stop
    ;;
  down)
    compose down --volumes --remove-orphans
    ;;
  *)
    echo "usage: local-stack.sh up|test|status|logs [service]|stop|down" >&2
    exit 2
    ;;
esac
