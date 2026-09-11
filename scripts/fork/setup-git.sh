#!/usr/bin/env bash
# One-time (idempotent) git configuration for this fork's clone.
#
#   bash scripts/fork/setup-git.sh [--quiet]
#
# Safe to run repeatedly and from `pnpm install` (prepare): it is a no-op outside
# a git checkout, needs no network, and only touches repo-local git config.
set -euo pipefail
# shellcheck source=scripts/fork/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

quiet=0
[[ "${1:-}" == "--quiet" ]] && quiet=1
say() { (( quiet )) || log "$@"; }

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  # e.g. a Docker build context without .git — nothing to configure.
  exit 0
fi
cd "$(fork_repo_root)"

# 1. Upstream remote.
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  say "added remote $UPSTREAM_REMOTE -> $UPSTREAM_URL"
else
  current="$(git remote get-url "$UPSTREAM_REMOTE")"
  case "$current" in
    https://github.com/crbnos/carbon|https://github.com/crbnos/carbon.git|git@github.com:crbnos/carbon.git|ssh://git@github.com/crbnos/carbon.git)
      say "remote $UPSTREAM_REMOTE already points at crbnos/carbon" ;;
    *)
      git remote set-url "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
      say "replaced stale remote $UPSTREAM_REMOTE url ($current) with $UPSTREAM_URL" ;;
  esac
fi

# 1b. Record the trunk as origin's default branch (offline: only a symbolic
# ref). Tools that look up "the default branch" — the backup-manifest baseline
# check among them — read origin/HEAD, which a clone made before saturn/main
# became the GitHub default still points at main.
if git rev-parse --verify --quiet "refs/remotes/origin/$FORK_TRUNK" >/dev/null; then
  if [[ "$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)" != "refs/remotes/origin/$FORK_TRUNK" ]]; then
    git remote set-head origin "$FORK_TRUNK"
    say "pointed origin/HEAD at origin/$FORK_TRUNK"
  fi
fi

# 2. Conflict reuse and readable conflict markers.
git config rerere.enabled true
git config rerere.autoupdate true
git config merge.conflictstyle zdiff3
say "set rerere.enabled=true rerere.autoupdate=true merge.conflictstyle=zdiff3"

# 3. Remove merge-driver definitions left behind by the retired sync tooling.
# The inventory found no custom driver names in the previous tooling (it used
# only git's built-in `text` and `union` strategies), so this list is empty; add
# a name here if an old clone turns out to carry one.
legacy_drivers=()
for name in ${legacy_drivers[@]+"${legacy_drivers[@]}"}; do
  if git config --get-regexp "^merge\.${name}\." >/dev/null 2>&1; then
    git config --remove-section "merge.${name}"
    say "removed legacy merge driver '${name}'"
  fi
done

# 4. The regen driver: generated files take upstream's version, never conflict,
# and are regenerated from the merged sources by scripts/fork/regenerate.sh.
# %B is the other side (upstream), %A is ours and the output slot.
git config "merge.${REGEN_DRIVER}.name" "take upstream version; regenerate after merge"
git config "merge.${REGEN_DRIVER}.driver" "cp %B %A"
say "registered merge driver '${REGEN_DRIVER}' (cp %B %A)"

if (( ! quiet )); then
  log "generated files covered by the ${REGEN_DRIVER} driver:"
  regen_paths | sed 's/^/    /'
fi
