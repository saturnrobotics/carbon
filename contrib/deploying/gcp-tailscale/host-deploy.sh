#!/usr/bin/env bash
# VM-side lifecycle. The caller quiesces and snapshots the data disk between
# prepare and apply. All generated state stays outside the source checkout.
set -euo pipefail
umask 077

readonly STATE=/var/lib/carbon
readonly CONFIG=${1:?Usage: host-deploy.sh CONFIG_JSON REPO_PATH COMMAND}
readonly REPO=${2:?Usage: host-deploy.sh CONFIG_JSON REPO_PATH COMMAND}
readonly ACTION=${3:?Expected prepare, quiesce, routine-migrate, routine-apply, maintenance-apply, start, or check}
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

build_image() {
  local pins pin
  local -a base_args=()
  pins=$(python3 - "$CONFIG" <<'PY'
import json, re, sys
config = json.load(open(sys.argv[1]))
if "RELEASE_BASE_IMAGES" in config:
    pins = config["RELEASE_BASE_IMAGES"]
    expected = {"NODE_IMAGE": "node:22", "NODE_SLIM_IMAGE": "node:22-slim"}
    if not isinstance(pins, dict) or set(pins) != set(expected):
        raise SystemExit("RELEASE_BASE_IMAGES requires both pinned Node images")
    for key, image in expected.items():
        value = pins[key]
        if not isinstance(value, str) or not re.fullmatch(re.escape(image) + r"@sha256:[a-f0-9]{64}", value):
            raise SystemExit("Invalid immutable base image reference for " + key)
        print(key + "=" + value)
PY
  ) || return 1
  while IFS= read -r pin; do
    [ -z "$pin" ] || base_args+=(--build-arg "$pin")
  done <<< "$pins"
  docker build ${base_args[@]+"${base_args[@]}"} "$@" "$REPO"
}

plan_services() {
  local section=$1
  python3 - "$CONFIG" "$section" <<'PY'
import json, sys
plan = json.load(open(sys.argv[1])).get("RELEASE_PLAN", {})
for name in sorted(plan.get(sys.argv[2], {})):
    if name not in {"erp", "mes"}:
        raise SystemExit("Only app services may use the routine release path")
    print(name)
PY
}

verify_release_cas_and_drift() {
  python3 - "$CONFIG" "$STATE/runtime/release-manifest.json" "$CURRENT" <<'PY'
import json, sys
config, manifest_path, compose_path = map(__import__('pathlib').Path, sys.argv[1:])
plan = json.loads(config.read_text()).get("RELEASE_PLAN", {})
expected = plan.get("expected_generation", 0)
current = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"generation": 0}
if current.get("generation") != expected:
    raise SystemExit("Release manifest generation changed; re-plan before promotion")
if not compose_path.exists():
    raise SystemExit(0)
compose = json.loads(compose_path.read_text())
for name, service in plan.get("services", {}).items():
    observed = service.get("observed_config_digest")
    active = compose.get("services", {}).get(name, {}).get("labels", {}).get("com.carbon.release.config-digest", "")
    if observed and active != observed:
        raise SystemExit("Manual configuration drift for " + name + "; review it before promotion")
PY
  while IFS=$'\t' read -r service expected; do
    [ -n "$expected" ] || continue
    container=$(docker ps --filter label=com.docker.compose.project=carbon --filter "label=com.docker.compose.service=$service" --quiet)
    [ -n "$container" ] || fail "Expected running service $service is absent; review before promotion."
    active=$(docker inspect --format '{{ index .Config.Labels "com.carbon.release.config-digest" }}' "$container")
    [ "$active" = "$expected" ] || fail "Manual configuration drift for $service; review it before promotion."
  done < <(python3 - "$CONFIG" <<'PY'
import json, sys
for name, service in json.load(open(sys.argv[1])).get("RELEASE_PLAN", {}).get("services", {}).items():
    if service.get("observed_config_digest"):
        print(name + "\t" + service["observed_config_digest"])
PY
)
}

promote_selected_compose() {
  python3 - "$CONFIG" "$CURRENT" "$PREPARED/compose.json" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
config, current_path, prepared_path = map(Path, sys.argv[1:])
plan = json.loads(config.read_text()).get("RELEASE_PLAN", {})
selected = set(plan.get("deploy", {}))
prepared = json.loads(prepared_path.read_text())
if current_path.exists():
    current = json.loads(current_path.read_text())
else:
    current = prepared
    selected = set(prepared.get("services", {}))
for name in selected:
    if name not in {"erp", "mes"}:
        raise SystemExit("Only app services may use the routine release path")
    current["services"][name] = prepared["services"][name]
fd, temporary = tempfile.mkstemp(dir=current_path.parent, prefix="compose.")
with os.fdopen(fd, "w") as stream:
    json.dump(current, stream, indent=2)
    stream.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, current_path)
PY
}

restore_selected_compose() {
  local previous="$STATE/runtime/routine-previous-compose.json"
  [ -f "$previous" ] || fail "No previous routine Compose definition is available for app rollback."
  python3 - "$CONFIG" "$CURRENT" "$previous" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
config, current_path, previous_path = map(Path, sys.argv[1:])
selected = set(json.loads(config.read_text()).get("RELEASE_PLAN", {}).get("deploy", {}))
current, previous = json.loads(current_path.read_text()), json.loads(previous_path.read_text())
for name in selected:
    if name not in {"erp", "mes"} or name not in previous.get("services", {}):
        raise SystemExit("Only a previously deployed app may be rolled back automatically")
    current["services"][name] = previous["services"][name]
fd, temporary = tempfile.mkstemp(dir=current_path.parent, prefix="compose.rollback.")
with os.fdopen(fd, "w") as stream:
    json.dump(current, stream, indent=2)
    stream.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, current_path)
PY
}

save_release_manifest() {
  python3 - "$CONFIG" "$STATE/runtime/release-manifest.json" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
config, destination = map(Path, sys.argv[1:])
plan = json.loads(config.read_text())["RELEASE_PLAN"]
manifest = {"generation": plan["generation"], "services": plan["services"]}
if plan.get("maintenance_fingerprint"):
    manifest["maintenance_fingerprint"] = plan["maintenance_fingerprint"]
fd, temporary = tempfile.mkstemp(dir=destination.parent, prefix="release-manifest.")
with os.fdopen(fd, "w") as stream:
    json.dump(manifest, stream, sort_keys=True)
    stream.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, destination)
PY
}

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
    if [ "$(config_value RELEASE_MAINTENANCE)" = True ]; then
      targets="erp mes"
      build_image --target ops --tag "carbon/ops:$REVISION"
    else
      targets=$(plan_services build)
      if [ -n "$(plan_services migrate)" ]; then build_image --target ops --tag "carbon/ops:$REVISION"; fi
    fi
    for target in $targets; do build_image --build-arg "APP=$target" --tag "carbon/$target:$REVISION"; done
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
  routine-migrate)
    verify_tailnet
    [ -f "$CURRENT" ] || fail "Routine migrations require an existing deployment."
    verify_release_cas_and_drift
    compose --profile ops run --rm --no-deps ops sh -c \
      'pnpm exec supabase migration up --include-all --db-url "postgresql://supabase_admin:${PGPASSWORD}@postgres:5432/postgres"'
    ;;
  routine-apply)
    verify_tailnet
    [ -f "$PREPARED/compose.json" ] || fail "Run prepare before routine-apply."
    verify_release_cas_and_drift
    mkdir -p "$STATE/runtime"
    cp "$CURRENT" "$STATE/runtime/routine-previous-compose.json"
    promote_selected_compose
    if ! while IFS= read -r service; do
      [ -n "$service" ] || continue
      compose up -d --no-deps "$service"
      wait_service "$service"
    done < <(plan_services deploy); then
      restore_selected_compose
      while IFS= read -r service; do
        [ -n "$service" ] || continue
        compose up -d --no-deps "$service"
        wait_service "$service"
      done < <(plan_services deploy)
      fail "Changed app health check failed; restored only the compatible changed app."
    fi
    save_release_manifest
    ;;
  maintenance-apply)
    verify_tailnet
    [ -f "$PREPARED/compose.json" ] || fail "Run prepare before maintenance-apply."
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
    save_release_manifest
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
  *) fail "Expected prepare, quiesce, routine-migrate, routine-apply, maintenance-apply, start, or check." ;;
esac
