#!/bin/sh
set -eu

directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository=$(CDPATH='' cd -- "$directory/../../.." && pwd)
compose_file="$directory/compose.local.yaml"

# Stack name, image tag and published ports are overridable so a second stack
# can run beside one that is already up. CI leaves all of them unset and gets
# the historical project name, `manual-v1` tags and the fixed ports.
KNOWLEDGE_LOCAL_STACK=${KNOWLEDGE_LOCAL_STACK:-knowledge-manual-local}
KNOWLEDGE_LOCAL_TAG=${KNOWLEDGE_LOCAL_TAG:-manual-v1}
KNOWLEDGE_LOCAL_PORTAL_PORT=${KNOWLEDGE_LOCAL_PORTAL_PORT:-4200}
KNOWLEDGE_LOCAL_GATEWAY_PORT=${KNOWLEDGE_LOCAL_GATEWAY_PORT:-4301}
KNOWLEDGE_LOCAL_QUERY_PORT=${KNOWLEDGE_LOCAL_QUERY_PORT:-4302}
KNOWLEDGE_LOCAL_DATABASE_PORT=${KNOWLEDGE_LOCAL_DATABASE_PORT:-59910}
KNOWLEDGE_LOCAL_REDIS_PORT=${KNOWLEDGE_LOCAL_REDIS_PORT:-59911}
KNOWLEDGE_LOCAL_STORAGE_PORT=${KNOWLEDGE_LOCAL_STORAGE_PORT:-59912}
KNOWLEDGE_LOCAL_INNGEST_PORT=${KNOWLEDGE_LOCAL_INNGEST_PORT:-59914}
export KNOWLEDGE_LOCAL_STACK KNOWLEDGE_LOCAL_TAG \
  KNOWLEDGE_LOCAL_PORTAL_PORT KNOWLEDGE_LOCAL_GATEWAY_PORT \
  KNOWLEDGE_LOCAL_QUERY_PORT KNOWLEDGE_LOCAL_DATABASE_PORT \
  KNOWLEDGE_LOCAL_REDIS_PORT KNOWLEDGE_LOCAL_STORAGE_PORT \
  KNOWLEDGE_LOCAL_INNGEST_PORT

compose() {
  docker compose -p "$KNOWLEDGE_LOCAL_STACK" -f "$compose_file" "$@"
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
  compose up -d parser ingest inngest query portal
  wait_http "http://127.0.0.1:$KNOWLEDGE_LOCAL_GATEWAY_PORT/health" 120
  wait_http "http://127.0.0.1:$KNOWLEDGE_LOCAL_QUERY_PORT/health" 120
  wait_http "http://127.0.0.1:$KNOWLEDGE_LOCAL_INNGEST_PORT/" 120
  wait_http "https://127.0.0.1:$KNOWLEDGE_LOCAL_PORTAL_PORT/" 120
  echo "Knowledge manual stack is ready at https://localhost:$KNOWLEDGE_LOCAL_PORTAL_PORT"
}

case "${1:-up}" in
  up)
    start
    ;;
  test)
    start
    database_container=$(compose ps -q postgres)
    KNOWLEDGE_E2E_BASE_URL=https://localhost:$KNOWLEDGE_LOCAL_PORTAL_PORT \
    KNOWLEDGE_E2E_DATABASE_CONTAINER=$database_container \
    KNOWLEDGE_E2E_DATABASE_PORT=$KNOWLEDGE_LOCAL_DATABASE_PORT \
    KNOWLEDGE_E2E_DATABASE_URL=postgresql://supabase_admin:synthetic-test-only@127.0.0.1:$KNOWLEDGE_LOCAL_DATABASE_PORT/knowledge_test \
    KNOWLEDGE_E2E_GATEWAY_URL=http://127.0.0.1:$KNOWLEDGE_LOCAL_GATEWAY_PORT \
    KNOWLEDGE_E2E_QUERY_FIXTURE_URL=http://127.0.0.1:$KNOWLEDGE_LOCAL_QUERY_PORT \
    KNOWLEDGE_E2E_SYNTHETIC_FIXTURES=1 \
      corepack pnpm --dir "$repository" --filter knowledge test:e2e
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
  *)
    echo "usage: local-stack.sh up|test|status|logs [service]|stop" >&2
    exit 2
    ;;
esac
