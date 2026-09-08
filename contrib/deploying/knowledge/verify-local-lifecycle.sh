#!/bin/sh
set -eu

directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
compose_file="$directory/compose.local.yaml"
services="postgres storage redis ingest inngest query parser storage-api portal"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/knowledge-lifecycle.XXXXXX")
base_tag=knowledge-manual-local-web-e2e:lifecycle-base
update_tag=knowledge-manual-local-web-e2e:lifecycle-update
compose_tag=knowledge-manual-local-web-e2e:manual-v1
restore_compose_tag=false

cleanup() {
  if [ "$restore_compose_tag" = true ]; then
    docker tag "$base_tag" "$compose_tag"
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT

compose() {
  docker compose -f "$compose_file" "$@"
}

snapshot_ids() {
  destination=$1
  : >"$destination"
  for service in $services; do
    container_id=$(compose ps -q "$service")
    [ -n "$container_id" ] || {
      echo "Knowledge service is not running: $service" >&2
      exit 1
    }
    printf '%s=%s\n' "$service" "$container_id" >>"$destination"
  done
}

wait_http() {
  url=$1
  attempts=60
  while [ "$attempts" -gt 0 ]; do
    if curl --fail --silent --show-error --insecure "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 1
  done
  echo "Timed out waiting for $url" >&2
  exit 1
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

assert_object_and_routes() {
  encoded_key=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$object_key")
  curl --fail --silent --show-error \
    "http://127.0.0.1:59912/storage/v1/b/knowledge-e2e/o/$encoded_key" \
    >"$temporary/metadata.json"
  python3 - "$object_generation" "$object_size" "$temporary/metadata.json" <<'PY'
import json
import sys

metadata = json.load(open(sys.argv[3], encoding="utf-8"))
assert metadata["generation"] == sys.argv[1]
assert metadata["size"] == sys.argv[2]
assert metadata["contentType"] == "application/pdf"
PY
  curl --fail --silent --show-error \
    "http://127.0.0.1:59912/download/storage/v1/b/knowledge-e2e/o/$encoded_key?alt=media&generation=$object_generation" \
    >"$temporary/original.pdf"
  [ "$(file_sha256 "$temporary/original.pdf")" = "$object_hash" ]

  curl --fail --silent --show-error -X POST http://127.0.0.1:4302/v1/query \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer e2e-service' \
    -H 'x-portal-user-evidence: e2e-iap:bob' \
    -H 'x-portal-company-id: company-b' \
    --data "{\"requestId\":\"local-lifecycle-proof\",\"text\":\"$part_number\",\"mode\":\"locate\",\"locale\":\"en\"}" \
    >"$temporary/query.json"
  python3 - "$version_id" "$temporary/query.json" <<'PY'
import json
import sys

result = json.load(open(sys.argv[2], encoding="utf-8"))
assert any(item.get("documentVersionId") == sys.argv[1] for item in result["evidence"])
PY

  curl --fail --silent --show-error --insecure \
    -b knowledge_e2e_actor=bob \
    "https://localhost:4200/documents/$document_id/versions/$version_id" \
    >"$temporary/portal-original.pdf"
  [ "$(file_sha256 "$temporary/portal-original.pdf")" = "$object_hash" ]
}

postgres_container=$(compose ps -q postgres)
storage_container=$(compose ps -q storage)
for container in "$postgres_container" "$storage_container"; do
  [ "$(docker inspect --format '{{index .Config.Labels "knowledge.disposable"}}' "$container")" = true ]
  [ "$(docker inspect --format '{{index .Config.Labels "knowledge.stack"}}' "$container")" = manual-local ]
done
if docker inspect --format '{{json .Args}}' "$storage_container" | grep -q -- '"-data"'; then
  echo "Storage still has the destructive seed-import argument" >&2
  exit 1
fi

IFS='|' read -r document_id version_id object_key object_generation object_hash object_size part_number <<EOF
$(docker exec -e PGPASSWORD=synthetic-test-only "$postgres_container" \
  psql -X -U supabase_admin -d knowledge_test -At -F '|' -c \
  "SELECT d.id,v.id,v.\"objectKey\",v.\"objectGeneration\",v.\"contentHash\",v.\"byteCount\",v.\"reviewedMetadata\"->>'partNumber' FROM knowledge.document d JOIN knowledge.\"documentVersion\" v ON v.id=d.\"currentVersionId\" AND v.\"companyId\"=d.\"companyId\" WHERE d.\"companyId\"='company-b' AND d.\"sourceId\"='source-b' AND d.status='published' AND d.\"deletedAt\" IS NULL ORDER BY d.\"createdAt\" DESC LIMIT 1")
EOF
[ -n "$document_id" ] && [ -n "$part_number" ]

snapshot_ids "$temporary/before-restart.ids"
assert_object_and_routes
compose restart postgres storage
wait_http http://127.0.0.1:59912/storage/v1/b
attempts=60
while [ "$attempts" -gt 0 ]; do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "$postgres_container")" = healthy ]; then
    break
  fi
  attempts=$((attempts - 1))
  sleep 1
done
[ "$attempts" -gt 0 ]
wait_http http://127.0.0.1:4301/health
wait_http http://127.0.0.1:4302/health
snapshot_ids "$temporary/after-restart.ids"
cmp "$temporary/before-restart.ids" "$temporary/after-restart.ids"
assert_object_and_routes
echo "Ordinary restart retained every container ID and the exact object generation/hash."

snapshot_ids "$temporary/before-app-restart.ids"
compose restart redis
attempts=60
redis_container=$(compose ps -q redis)
while [ "$attempts" -gt 0 ]; do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "$redis_container")" = healthy ]; then
    break
  fi
  attempts=$((attempts - 1))
  sleep 1
done
[ "$attempts" -gt 0 ]
compose restart parser storage-api ingest inngest query portal
wait_http http://127.0.0.1:4301/health
wait_http http://127.0.0.1:4302/health
wait_http http://127.0.0.1:59914/
wait_http https://127.0.0.1:4200/
snapshot_ids "$temporary/after-app-restart.ids"
cmp "$temporary/before-app-restart.ids" "$temporary/after-app-restart.ids"
curl --fail --silent --show-error http://127.0.0.1:4301/__e2e/status \
  >"$temporary/outbox-status.json"
python3 - "$temporary/outbox-status.json" <<'PY'
import json
import sys

status = json.load(open(sys.argv[1], encoding="utf-8"))
assert status["pending"] == 0
PY
assert_object_and_routes
echo "Application/background restart retained every container ID, pending=0, query, and download."

docker tag "$compose_tag" "$base_tag"
restore_compose_tag=true
base_image=$(docker image inspect --format '{{.Id}}' "$base_tag")
proof_nonce=$(python3 -c 'import uuid; print(uuid.uuid4())')
docker build --quiet --build-arg BASE_IMAGE="$base_tag" --build-arg PROOF_NONCE="$proof_nonce" \
  --tag "$update_tag" - <<'DOCKERFILE' >/dev/null
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG PROOF_NONCE
LABEL knowledge.lifecycle-proof=${PROOF_NONCE}
DOCKERFILE
updated_image=$(docker image inspect --format '{{.Id}}' "$update_tag")
[ "$updated_image" != "$base_image" ]
docker tag "$update_tag" "$compose_tag"
snapshot_ids "$temporary/before-update.ids"
old_portal=$(compose ps -q portal)
compose up -d --no-deps portal
wait_http https://127.0.0.1:4200/
snapshot_ids "$temporary/after-update.ids"
new_portal=$(compose ps -q portal)
[ "$new_portal" != "$old_portal" ]
[ "$(docker inspect --format '{{.Image}}' "$new_portal")" = "$updated_image" ]
for service in $services; do
  [ "$service" = portal ] && continue
  before=$(awk -F= -v name="$service" '$1==name {print $2}' "$temporary/before-update.ids")
  after=$(awk -F= -v name="$service" '$1==name {print $2}' "$temporary/after-update.ids")
  [ "$before" = "$after" ]
done
assert_object_and_routes
docker tag "$base_tag" "$compose_tag"
restore_compose_tag=false
echo "Portal update changed its image/container IDs; every other container ID remained unchanged."
printf 'portalBaseImage=%s portalUpdatedImage=%s portalBefore=%s portalAfter=%s\n' \
  "$base_image" "$updated_image" "$old_portal" "$new_portal"
printf 'activeDocument=%s version=%s generation=%s sha256=%s part=%s\n' \
  "$document_id" "$version_id" "$object_generation" "$object_hash" "$part_number"
