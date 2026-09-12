#!/bin/sh
set -eu

directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository=$(CDPATH='' cd -- "$directory/../../.." && pwd)
compose_file="$directory/compose.local.yaml"

# Loopback host ports. Each defaults to its historical value, so an
# unparameterised invocation is unchanged; a concurrent harness overrides the
# ones it needs and owns its own stack name, image tag and volumes.
portal_port=${KNOWLEDGE_PORT_PORTAL:-4200}
gateway_port=${KNOWLEDGE_PORT_GATEWAY:-4301}
query_port=${KNOWLEDGE_PORT_QUERY:-4302}
inngest_port=${KNOWLEDGE_PORT_INNGEST:-59914}
database_port=${KNOWLEDGE_PORT_POSTGRES:-59910}
export KNOWLEDGE_PORT_PORTAL="$portal_port"
export KNOWLEDGE_PORT_GATEWAY="$gateway_port"
export KNOWLEDGE_PORT_QUERY="$query_port"
export KNOWLEDGE_PORT_INNGEST="$inngest_port"
export KNOWLEDGE_PORT_POSTGRES="$database_port"

compose() {
  docker compose -f "$compose_file" "$@"
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
  wait_http "http://127.0.0.1:$gateway_port/health" 120
  wait_http "http://127.0.0.1:$query_port/health" 120
  wait_http "http://127.0.0.1:$inngest_port/" 120
  wait_http "https://127.0.0.1:$portal_port/" 120
  echo "Knowledge manual stack is ready at https://localhost:$portal_port"
}

case "${1:-up}" in
  up)
    start
    ;;
  test)
    start
    database_container=$(compose ps -q postgres)
    KNOWLEDGE_E2E_BASE_URL="https://localhost:$portal_port" \
    KNOWLEDGE_E2E_DATABASE_CONTAINER=$database_container \
    KNOWLEDGE_E2E_DATABASE_PORT="$database_port" \
    KNOWLEDGE_E2E_DATABASE_URL="postgresql://supabase_admin:synthetic-test-only@127.0.0.1:$database_port/knowledge_test" \
    KNOWLEDGE_E2E_GATEWAY_URL="http://127.0.0.1:$gateway_port" \
    KNOWLEDGE_E2E_QUERY_FIXTURE_URL="http://127.0.0.1:$query_port" \
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
  down)
    compose down --volumes --remove-orphans
    ;;
  *)
    echo "usage: local-stack.sh up|test|status|logs [service]|stop|down" >&2
    exit 2
    ;;
esac
