#!/usr/bin/env bash
# VM-side lifecycle. The caller quiesces and snapshots the data disk between
# prepare and apply. All generated state stays outside the source checkout.
set -euo pipefail
umask 077

readonly STATE=/var/lib/carbon
readonly CONFIG=${1:?Usage: host-deploy.sh CONFIG_JSON REPO_PATH COMMAND}
readonly REPO=${2:?Usage: host-deploy.sh CONFIG_JSON REPO_PATH COMMAND}
readonly ACTION=${3:?Expected prepare, quiesce, apply, start, or check}
readonly HERE="$REPO/contrib/deploying/gcp-tailscale"
readonly CURRENT="$STATE/runtime/compose.json"

fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "Run this VM helper as root."
[ -f "$CONFIG" ] && [ -f "$REPO/Dockerfile" ] || fail "Private configuration or source release is missing."

config_value() {
  python3 - "$CONFIG" "$1" <<'PY'
import json, sys
with open(sys.argv[1]) as stream:
    print(json.load(stream)[sys.argv[2]])
PY
}

REVISION=$(config_value DEPLOY_REVISION)
[[ "$REVISION" =~ ^[a-f0-9]{40,64}$ ]] || fail "Invalid source revision."
readonly REVISION
readonly PREPARED="$STATE/prepared/$REVISION"

compose() { docker compose --project-name carbon --file "$CURRENT" "$@"; }

wait_service() {
  local service=$1 elapsed=0 timeout=${2:-240} container status
  while [ "$elapsed" -lt "$timeout" ]; do
    container=$(compose ps --all --quiet "$service")
    if [ -n "$container" ]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
      [ "$status" != healthy ] || return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  fail "$service did not become healthy. Inspect its private VM logs with docker compose."
}

verify_tailnet() {
  local expected actual
  expected=$(config_value TAILSCALE_IP)
  actual=$(tailscale ip -4)
  [ "$actual" = "$expected" ] || fail "Configured Tailscale address does not match this VM."
  tailscale status --json | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("BackendState") == "Running" else 1)' \
    || fail "Tailscale is not connected."
  tailscale serve status --json | python3 -c 'import json,sys; sys.exit(1 if any((json.load(sys.stdin) or {}).get("AllowFunnel", {}).values()) else 0)' \
    || fail "Tailscale Funnel must be disabled for this private deployment."
}

check_stack() {
  verify_tailnet
  for service in postgres storage gotrue postgrest redis inngest erp mes kong caddy; do
    # PostgREST is a scratch image with no health probe. Its readiness is also
    # checked by the ERP dependency health response.
    if [ "$service" = postgrest ]; then
      [ -n "$(compose ps --status running --quiet postgrest)" ] || fail "PostgREST is not running."
    else
      wait_service "$service"
    fi
  done
  # Verify private TLS routing and dependencies from the VM's tailnet address.
  local host expected
  expected=$(config_value TAILSCALE_IP)
  host=$(config_value ERP_HOST)
  curl --fail --silent --show-error --max-time 15 --resolve "$host:443:$expected" "https://$host/health" \
    | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("status") == "healthy" else 1)'
  host=$(config_value MES_HOST)
  curl --fail --silent --show-error --max-time 15 --resolve "$host:443:$expected" "https://$host/health" >/dev/null
  host=$(config_value SUPABASE_HOST)
  curl --fail --silent --show-error --max-time 15 --resolve "$host:443:$expected" "https://$host/auth/v1/health" >/dev/null
  # Force a real signed SDK registration after ERP starts; Inngest's boot-time
  # attempt may race the build or migrations on the first deployment.
  compose exec -T erp /usr/local/bin/carbon-secrets-entrypoint.sh node --input-type=module -e '
    const response = await fetch("http://erp:3000/api/inngest", {method: "PUT"});
    if (!response.ok) throw new Error("Inngest app registration failed: " + response.status);
  '
  # Prove database-triggered jobs can reach the local event server.
  compose exec -T erp /usr/local/bin/carbon-secrets-entrypoint.sh node --input-type=module -e '
    const response = await fetch("http://kong:8000/functions/v1/event-wake", {
      method: "POST", headers: {"Authorization":"Bearer " + process.env.SUPABASE_ANON_KEY,"Content-Type":"application/json"}, body:"{}"
    });
    if (!response.ok) throw new Error("Local event wake failed: " + response.status);
  '
  printf '%s\n' "Private ERP, MES, Supabase and event processing passed readiness checks."
}

case "$ACTION" in
  prepare)
    verify_tailnet
    [ -f "$STATE/tls/live/carbon/fullchain.pem" ] && [ -f "$STATE/tls/live/carbon/privkey.pem" ] \
      || fail "Obtain the private deployment's DNS-validated certificate first."
    mkdir -p "$PREPARED"
    python3 "$HERE/render.py" "$CONFIG" "$REPO" "$PREPARED"
    docker compose --project-name carbon --file "$PREPARED/compose.json" config --quiet
    for target in ops erp mes; do
      if [ "$target" = ops ]; then
        docker build --target ops --tag "carbon/ops:$REVISION" "$REPO"
      else
        docker build --build-arg "APP=$target" --tag "carbon/$target:$REVISION" "$REPO"
      fi
    done
    printf '%s\n' "Prepared immutable source release; running containers are unchanged."
    ;;
  quiesce)
    if [ -f "$CURRENT" ]; then
      compose --profile bootstrap stop --timeout 120
    fi
    [ -z "$(docker ps --filter label=com.docker.compose.project=carbon --quiet)" ] \
      || fail "Carbon still has running containers; do not snapshot yet."
    sync
    printf '%s\n' "Carbon stopped; snapshot the data disk before apply."
    ;;
  apply)
    verify_tailnet
    [ -f "$PREPARED/compose.json" ] || fail "Run prepare before apply."
    [ -z "$(docker ps --filter label=com.docker.compose.project=carbon --quiet)" ] \
      || fail "Run quiesce and snapshot the data disk before applying a release."
    mkdir -p "$STATE/runtime"
    if [ -f "$CURRENT" ]; then cp "$CURRENT" "$STATE/runtime/previous-compose.json"; fi
    cp "$PREPARED/compose.json" "$CURRENT"
    compose --profile bootstrap up -d postgres storage gotrue-bootstrap
    wait_service postgres
    wait_service storage
    wait_service gotrue-bootstrap
    # Expansion belongs to the container, after its secret entrypoint ran.
    # shellcheck disable=SC2016
    compose --profile ops run --rm --no-deps ops sh -c \
      'pnpm exec supabase migration up --include-all --db-url "postgresql://supabase_admin:${PGPASSWORD}@postgres:5432/postgres"'
    compose --profile bootstrap stop --timeout 30 gotrue-bootstrap
    allowed_domain=$(config_value AUTH_ALLOWED_GOOGLE_DOMAIN)
    # shellcheck disable=SC2016
    compose exec -T -e "ALLOWED_EMAIL_DOMAIN=$allowed_domain" postgres /usr/local/bin/carbon-secrets-entrypoint.sh sh -c \
      'psql -X -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -v allowed_email_domain="$ALLOWED_EMAIL_DOMAIN" -f -' \
      < "$HERE/auth/google-domain-hook.sql"
    # Preserve independently provisioned client isolation after upstream SQL.
    # shellcheck disable=SC2016
    compose exec -T postgres /usr/local/bin/carbon-secrets-entrypoint.sh sh -c \
      'psql -X -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f -' \
      < "$HERE/private-client-isolation.sql"
    compose up -d postgrest kong edge-runtime redis
    wait_service kong
    # Only config and plan lookups are upserted. No users, company details, demo
    # data, destructive reset or migration-ledger repair enters this path.
    compose --profile ops run --rm --no-deps ops pnpm exec tsx src/seed.ts
    compose up -d
    check_stack
    printf '%s\n' "$REVISION" > "$STATE/runtime/revision"
    ;;
  start)
    [ -f "$CURRENT" ] || fail "No existing deployment to start."
    verify_tailnet
    compose up -d
    check_stack
    ;;
  check)
    [ -f "$CURRENT" ] || fail "No deployment to check."
    check_stack
    ;;
  *) fail "Expected prepare, quiesce, apply, start, or check." ;;
esac
