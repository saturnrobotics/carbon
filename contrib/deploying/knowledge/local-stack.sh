#!/bin/sh
set -eu

directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository=$(CDPATH='' cd -- "$directory/../../.." && pwd)
compose_file="$directory/compose.local.yaml"

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
  wait_http http://127.0.0.1:4301/health 120
  wait_http http://127.0.0.1:4302/health 120
  wait_http http://127.0.0.1:59914/ 120
  wait_http https://127.0.0.1:4200/ 120
  echo "Knowledge manual stack is ready at https://localhost:4200"
}

case "${1:-up}" in
  up)
    start
    ;;
  test)
    start
    database_container=$(compose ps -q postgres)
    KNOWLEDGE_E2E_BASE_URL=https://localhost:4200 \
    KNOWLEDGE_E2E_DATABASE_CONTAINER=$database_container \
    KNOWLEDGE_E2E_DATABASE_PORT=59910 \
    KNOWLEDGE_E2E_DATABASE_URL=postgresql://supabase_admin:synthetic-test-only@127.0.0.1:59910/knowledge_test \
    KNOWLEDGE_E2E_GATEWAY_URL=http://127.0.0.1:4301 \
    KNOWLEDGE_E2E_QUERY_FIXTURE_URL=http://127.0.0.1:4302 \
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
