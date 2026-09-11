#!/usr/bin/env bash
# Migration ordering guard for upstream merges.
#
#   bash scripts/fork/check-migrations.sh [base-ref]     (default: the fork trunk)
#
# Compares the migrations in the merged tree (the index, so it also works while
# a merge is still in progress) with those on <base-ref>. Any migration the merge
# introduces whose timestamp is OLDER than the newest migration already on the
# base is printed as a warning: Supabase applies migrations by version, so an
# unapplied older version will still run, but its author never saw the schema
# state a later fork migration may already have changed.
#
# Exit status: 1 only for a hard problem (two migrations sharing a version
# number); otherwise 0, with warnings on stderr.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$(fork_repo_root)"

base="${1:-$FORK_TRUNK}"
dir="packages/database/supabase/migrations"
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || die "Unknown base ref: $base"

version_of() { basename "$1" | sed -E 's/^([0-9]{14})_.*/\1/'; }

merged="$(git ls-files -- "$dir" | grep -E '/[0-9]{14}_[^/]+\.sql$' || true)"
on_base="$(git ls-tree -r --name-only "$base" -- "$dir" | grep -E '/[0-9]{14}_[^/]+\.sql$' || true)"

# Hard failure: duplicate version numbers in the merged tree.
dupes="$(printf '%s\n' "$merged" | sed -E 's#.*/([0-9]{14})_.*#\1#' | sort | uniq -d)"
if [[ -n "$dupes" ]]; then
  for v in $dupes; do
    printf '\033[1;31m✗\033[0m duplicate migration version %s:\n' "$v" >&2
    printf '%s\n' "$merged" | grep "/${v}_" | sed 's/^/    /' >&2
  done
  die "Migrations must have unique version numbers; rename one side before committing."
fi

newest_base="$(printf '%s\n' "$on_base" | sed -E 's#.*/([0-9]{14})_.*#\1#' | sort | tail -1)"
introduced="$(comm -13 <(printf '%s\n' "$on_base" | sort) <(printf '%s\n' "$merged" | sort))"

if [[ -z "$introduced" ]]; then
  log "no new migrations relative to $base"
  exit 0
fi

log "migrations introduced relative to $base (newest already on base: ${newest_base:-none}):"
out_of_order=0
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  v="$(version_of "$file")"
  if [[ -n "$newest_base" && "$v" < "$newest_base" ]]; then
    printf '    \033[1;33m! %s\033[0m (older than %s)\n' "$file" "$newest_base"
    out_of_order=$((out_of_order + 1))
  else
    printf '      %s\n' "$file"
  fi
done <<< "$introduced"

if (( out_of_order > 0 )); then
  warn "$out_of_order migration(s) above are timestamped before the newest migration already on $base."
  warn "Supabase applies by version, so they will still run on databases that have not seen them,"
  warn "but confirm they do not assume schema state that a later fork migration already changed."
fi
exit 0
