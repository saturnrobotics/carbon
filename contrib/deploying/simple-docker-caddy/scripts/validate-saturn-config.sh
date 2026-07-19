#!/usr/bin/env bash
# Validate the domain and security settings for a Saturn rack environment
# without sourcing the secret-bearing environment file.
set -euo pipefail

environment="${1:-}"
config_file="${2:-}"

fail() {
  printf 'domain config error: %s\n' "$*" >&2
  exit 1
}

case "$environment" in
  production | staging) ;;
  *) fail "environment must be 'production' or 'staging'" ;;
esac

[[ -r "$config_file" ]] || fail "cannot read config file: $config_file"

value_of() {
  local key="$1" count value
  count="$(grep -c "^${key}=" "$config_file" || true)"
  [[ "$count" = "1" ]] || fail "$key must appear exactly once in $config_file"
  value="$(sed -n "s/^${key}=//p" "$config_file")"
  [[ "$value" != *$'\r'* ]] || fail "$key contains a carriage return"
  printf '%s' "$value"
}

expect_value() {
  local key="$1" expected="$2" actual
  actual="$(value_of "$key")"
  [[ "$actual" = "$expected" ]] ||
    fail "$key must be '$expected' for $environment (found '$actual')"
}

expect_non_placeholder() {
  local key="$1" actual
  actual="$(value_of "$key")"
  [[ -n "$actual" ]] || fail "$key must not be empty"
  [[ "$actual" != *"example.com"* ]] || fail "$key still contains example.com"
  [[ "$actual" != *"change_me"* ]] || fail "$key still contains a placeholder"
}

if [[ "$environment" = "production" ]]; then
  expect_value STACK_NAME carbon
  expect_value DOMAIN erp.hq.saturnrobotics.co
  expect_value ERP_HOST erp.hq.saturnrobotics.co
  expect_value ERP_URL https://erp.hq.saturnrobotics.co
  expect_value MES_HOST mes.hq.saturnrobotics.co
  expect_value MES_URL https://mes.hq.saturnrobotics.co
  expect_value SUPABASE_HOST supabase.hq.saturnrobotics.co
  expect_value SUPABASE_URL https://supabase.hq.saturnrobotics.co
  expect_value ERP_ACME_CHALLENGE_DOMAIN _acme-challenge.erp.hq.acme.saturnrobotics.co
  expect_value MES_ACME_CHALLENGE_DOMAIN _acme-challenge.mes.hq.acme.saturnrobotics.co
  expect_value SUPABASE_ACME_CHALLENGE_DOMAIN _acme-challenge.supabase.hq.acme.saturnrobotics.co
else
  expect_value STACK_NAME carbon-staging
  expect_value DOMAIN staging.erp.hq.saturnrobotics.co
  expect_value ERP_HOST staging.erp.hq.saturnrobotics.co
  expect_value ERP_URL https://staging.erp.hq.saturnrobotics.co
  expect_value MES_HOST staging.mes.hq.saturnrobotics.co
  expect_value MES_URL https://staging.mes.hq.saturnrobotics.co
  expect_value SUPABASE_HOST staging.supabase.hq.saturnrobotics.co
  expect_value SUPABASE_URL https://staging.supabase.hq.saturnrobotics.co
  expect_value ERP_ACME_CHALLENGE_DOMAIN _acme-challenge.staging.erp.hq.acme.saturnrobotics.co
  expect_value MES_ACME_CHALLENGE_DOMAIN _acme-challenge.staging.mes.hq.acme.saturnrobotics.co
  expect_value SUPABASE_ACME_CHALLENGE_DOMAIN _acme-challenge.staging.supabase.hq.acme.saturnrobotics.co
fi

expect_value TLS_MODE gcp-dns
expect_value CADDY_IMAGE carbon/caddy-gcp:2.11.4-1.1.0
expect_non_placeholder GCP_PROJECT
expect_value GOTRUE_DISABLE_SIGNUP true
expect_value STUDIO_HOST ""
expect_value STUDIO_REPLICAS 0
expect_non_placeholder ACME_EMAIL

printf 'Domain configuration is valid for %s: %s\n' "$environment" "$config_file"
