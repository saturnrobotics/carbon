#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

docker compose version >/dev/null

set -a
# shellcheck disable=SC1091
source "$here/.env.example"
set +a

export CARBON_REPO="$repo"
export STACK_NAME=carbon-staging
export DOMAIN=staging.erp.hq.saturnrobotics.co
export ERP_HOST=staging.erp.hq.saturnrobotics.co
export ERP_URL=https://staging.erp.hq.saturnrobotics.co
export MES_HOST=staging.mes.hq.saturnrobotics.co
export MES_URL=https://staging.mes.hq.saturnrobotics.co
export SUPABASE_HOST=staging.supabase.hq.saturnrobotics.co
export SUPABASE_URL=https://staging.supabase.hq.saturnrobotics.co
export ERP_ACME_CHALLENGE_DOMAIN=_acme-challenge.staging.erp.hq.acme.saturnrobotics.co
export MES_ACME_CHALLENGE_DOMAIN=_acme-challenge.staging.mes.hq.acme.saturnrobotics.co
export SUPABASE_ACME_CHALLENGE_DOMAIN=_acme-challenge.staging.supabase.hq.acme.saturnrobotics.co
export ACME_EMAIL=operations@saturnrobotics.co
export TLS_MODE=gcp-dns
export GCP_PROJECT=saturn-carbon-dns
export STUDIO_HOST=
export STUDIO_REPLICAS=0

docker compose \
  -f "$here/docker-compose.prod.yml" \
  -f "$here/docker-compose.gcp.yml" \
  config \
  | sed -E \
      -e '/^name:/d' \
      -e 's/^([[:space:]]+published:) "([0-9]+)"$/\1 \2/' \
    >"$rendered"

docker stack config -c "$rendered" >/dev/null

caddy_service="$(sed -n '/^  caddy:/,/^  [a-zA-Z0-9_-]*:/p' "$rendered")"
[[ "$(grep -c 'published: 443' <<<"$caddy_service")" = "2" ]]
grep -q 'protocol: tcp' <<<"$caddy_service"
grep -q 'protocol: udp' <<<"$caddy_service"
grep -q 'image: carbon/caddy-gcp:2.11.4-1.1.0' <<<"$caddy_service"
grep -q 'source: gcp_application_credentials' <<<"$caddy_service"
grep -q 'GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/gcp_application_credentials' <<<"$caddy_service"
grep -q 'GCP_PROJECT: saturn-carbon-dns' <<<"$caddy_service"
grep -q 'Caddyfile.gcp' <<<"$caddy_service"
grep -q 'ERP_ACME_CHALLENGE_DOMAIN: _acme-challenge.staging.erp.hq.acme.saturnrobotics.co' <<<"$caddy_service"

printf 'Google Cloud DNS-01 stack composition passed.\n'
