#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
validator="$here/validate-saturn-config.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

write_config() {
  local file="$1" stack="$2" domain="$3" erp_host="$4" mes_host="$5" supabase_host="$6"
  local erp_acme="$7" mes_acme="$8" supabase_acme="$9"
  printf '%s\n' \
    "STACK_NAME=$stack" \
    "DOMAIN=$domain" \
    "ERP_HOST=$erp_host" \
    "ERP_URL=https://$erp_host" \
    "MES_HOST=$mes_host" \
    "MES_URL=https://$mes_host" \
    "SUPABASE_HOST=$supabase_host" \
    "SUPABASE_URL=https://$supabase_host" \
    "ERP_ACME_CHALLENGE_DOMAIN=$erp_acme" \
    "MES_ACME_CHALLENGE_DOMAIN=$mes_acme" \
    "SUPABASE_ACME_CHALLENGE_DOMAIN=$supabase_acme" \
    "TLS_MODE=gcp-dns" \
    "CADDY_IMAGE=carbon/caddy-gcp:2.11.4-1.1.0" \
    "GCP_PROJECT=saturn-carbon-dns" \
    "GOTRUE_DISABLE_SIGNUP=true" \
    "STUDIO_HOST=" \
    "STUDIO_REPLICAS=0" \
    "ACME_EMAIL=operations@saturnrobotics.co" >"$file"
}

production="$tmp_dir/production.env"
staging="$tmp_dir/staging.env"
invalid="$tmp_dir/invalid.env"

write_config \
  "$production" carbon erp.hq.saturnrobotics.co \
  erp.hq.saturnrobotics.co mes.hq.saturnrobotics.co \
  supabase.hq.saturnrobotics.co \
  _acme-challenge.erp.hq.acme.saturnrobotics.co \
  _acme-challenge.mes.hq.acme.saturnrobotics.co \
  _acme-challenge.supabase.hq.acme.saturnrobotics.co
write_config \
  "$staging" carbon-staging staging.erp.hq.saturnrobotics.co \
  staging.erp.hq.saturnrobotics.co staging.mes.hq.saturnrobotics.co \
  staging.supabase.hq.saturnrobotics.co \
  _acme-challenge.staging.erp.hq.acme.saturnrobotics.co \
  _acme-challenge.staging.mes.hq.acme.saturnrobotics.co \
  _acme-challenge.staging.supabase.hq.acme.saturnrobotics.co
write_config \
  "$invalid" carbon-staging staging.erp.hq.saturnrobotics.co \
  staging.erp.hq.saturnrobotics.co mes.hq.saturnrobotics.co \
  staging.supabase.hq.saturnrobotics.co \
  _acme-challenge.staging.erp.hq.acme.saturnrobotics.co \
  _acme-challenge.staging.mes.hq.acme.saturnrobotics.co \
  _acme-challenge.staging.supabase.hq.acme.saturnrobotics.co

"$validator" production "$production"
"$validator" staging "$staging"

if "$validator" staging "$invalid" >/dev/null 2>&1; then
  printf 'expected invalid staging MES hostname to fail validation\n' >&2
  exit 1
fi

printf 'Saturn domain validator tests passed.\n'
