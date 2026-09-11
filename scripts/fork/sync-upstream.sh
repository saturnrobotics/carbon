#!/usr/bin/env bash
# Local upstream sync runner — the canonical manual flow.
#
#   bash scripts/fork/sync-upstream.sh [--dry-run] [--upstream-ref <ref>]
#
# From a clean checkout of the fork trunk (saturn/main):
#   1. fetch upstream; exit 0 if the trunk already contains upstream/main
#   2. create sync/upstream-YYYY-MM-DD (suffix -2, -3, ... if taken)
#   3. git merge --no-ff --no-commit upstream/main
#        generated files never conflict: the `regen` merge driver takes upstream's copy
#   4a. conflicts in real files -> print them and stop with exit 2 (merge left in progress);
#       resolve, then run scripts/fork/finish-sync.sh
#   4b. no conflicts -> regenerate.sh, check-migrations.sh, commit, print next steps
#
# --dry-run stops before committing: it reports the pending upstream commit count,
# the files that would conflict and the regen-driver files taken from upstream,
# then aborts the merge and deletes the temporary branch.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(fork_repo_root)"

dry_run=0
upstream_ref="$UPSTREAM_BRANCH"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --upstream-ref) shift; upstream_ref="${1:?--upstream-ref needs a value}" ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

# --- 1. Preconditions ---------------------------------------------------------
current="$(git symbolic-ref --quiet --short HEAD || true)"
[[ "$current" == "$FORK_TRUNK" ]] || die "Run this from the fork trunk: git switch $FORK_TRUNK   (currently on '${current:-detached HEAD}')"
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || die "Working tree must be clean (commit or stash your changes first)."
for op in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [[ -e "$(git rev-parse --git-path "$op")" ]] && die "Finish or abort the in-progress git operation first ($op)."
done
git config --get "merge.${REGEN_DRIVER}.driver" >/dev/null || die "The '${REGEN_DRIVER}' merge driver is not configured. Run: bash scripts/fork/setup-git.sh"

log "fetching $UPSTREAM_REMOTE"
git fetch --quiet "$UPSTREAM_REMOTE" "$upstream_ref"
target="$(git rev-parse FETCH_HEAD)"
# Keep the tracking ref current when syncing the default branch.
[[ "$upstream_ref" == "$UPSTREAM_BRANCH" ]] && git update-ref "refs/remotes/$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" "$target"
target_short="$(git rev-parse --short=10 "$target")"

if git merge-base --is-ancestor "$target" HEAD; then
  log "up to date: $FORK_TRUNK already contains $UPSTREAM_REMOTE/$upstream_ref ($target_short)"
  exit 0
fi
pending="$(git rev-list --count "HEAD..$target")"
log "$pending upstream commit(s) pending from $UPSTREAM_REMOTE/$upstream_ref ($target_short)"

# --- 2. Sync branch -------------------------------------------------------------
base_name="sync/upstream-$(date -u +%Y-%m-%d)"
branch="$base_name"; n=1
while git show-ref --verify --quiet "refs/heads/$branch" || git show-ref --verify --quiet "refs/remotes/origin/$branch"; do
  n=$((n + 1)); branch="$base_name-$n"
done
trunk_sha="$(git rev-parse HEAD)"
git switch --quiet -c "$branch"
log "created $branch from $FORK_TRUNK ($(git rev-parse --short=10 "$trunk_sha"))"

cleanup_dry_run() {
  git merge --abort 2>/dev/null || git reset --quiet --hard "$trunk_sha"
  git switch --quiet "$FORK_TRUNK"
  git branch --quiet -D "$branch"
}

# --- 3. Merge ---------------------------------------------------------------------
set +e
git merge --no-ff --no-commit "$target" >/dev/null 2>&1
merge_status=$?
set -e

conflicted="$(git diff --name-only --diff-filter=U)"
# Regen files taken from upstream: everything the merge changed that carries the driver.
regen_taken="$(git diff --cached --name-only "$trunk_sha" | git check-attr --stdin merge | awk -v d="$REGEN_DRIVER" -F': merge: ' '$2==d{print $1}')"

if (( dry_run )); then
  echo
  echo "DRY RUN — nothing was committed."
  echo "  branch that would be created : $branch"
  echo "  upstream target              : $UPSTREAM_REMOTE/$upstream_ref @ $target_short"
  echo "  pending upstream commits     : $pending"
  echo "  files changed by the merge   : $(git diff --cached --name-only "$trunk_sha" | wc -l | tr -d ' ')"
  echo "  regen-driver files from upstream ($(printf '%s\n' "$regen_taken" | grep -c . || true)):"
  printf '%s\n' "$regen_taken" | sed '/^$/d;s/^/      /'
  if [[ -n "$conflicted" ]]; then
    echo "  CONFLICTS in $(printf '%s\n' "$conflicted" | grep -c .) file(s):"
    printf '%s\n' "$conflicted" | sed 's/^/      /'
  else
    echo "  conflicts                    : none"
  fi
  bash "$here/check-migrations.sh" "$trunk_sha" 2>&1 | sed 's/^/  /' || true
  cleanup_dry_run
  log "merge aborted, $branch deleted, back on $FORK_TRUNK"
  exit 0
fi

# --- 4a. Conflict path ------------------------------------------------------------
if [[ -n "$conflicted" ]]; then
  echo
  printf '\033[1;31m✗\033[0m the merge stopped on %s conflicted file(s):\n' "$(printf '%s\n' "$conflicted" | grep -c .)"
  printf '%s\n' "$conflicted" | sed 's/^/    /'
  echo
  echo "fork-side drift of the conflicted files (lines added/deleted since the merge base):"
  printf '%s\n' "$conflicted" | tr '\n' '\0' | xargs -0 git diff --numstat "$target...$trunk_sha" -- | awk '{printf "    +%s -%s  %s\n", $1, $2, $3}'
  echo
  echo "The merge is left in progress on branch $branch. Resolve the files above"
  echo "(upstream is the intended direction for shared code, docs/fork/CUSTOMIZATIONS.md"
  echo "for fork-owned code), git add them, then run:"
  echo
  echo "    bash scripts/fork/finish-sync.sh"
  echo
  echo "To give up: git merge --abort && git switch $FORK_TRUNK && git branch -D $branch"
  # finish-sync.sh records this list in the merge commit so drift.sh can report it.
  printf '%s\n' "$conflicted" > "$(git rev-parse --git-path fork-sync-conflicts)"
  exit 2
fi
(( merge_status == 0 )) || die "git merge failed without reporting conflicts; inspect 'git status'." 

# --- 4b. Clean merge path -----------------------------------------------------------
log "merge is clean; regenerating generated files"
bash "$here/regenerate.sh"
bash "$here/check-migrations.sh" "$trunk_sha" || die "migration check failed"
git commit --quiet -m "Merge $UPSTREAM_REMOTE/$upstream_ref ($target_short) into $FORK_TRUNK" \
  -m "$pending upstream commit(s): $(git rev-parse --short=10 "$trunk_sha")..$target_short" \
  -m "Generated files regenerated with scripts/fork/regenerate.sh."
log "committed $(git rev-parse --short=10 HEAD) on $branch"
cat <<MSG

Next steps:
    pnpm exec biome check && pnpm run typegen && pnpm run typecheck && pnpm test
    git push -u origin $branch
    gh pr create --base $FORK_TRUNK --head $branch --label upstream-sync \\
      --title "Sync upstream $target_short ($(date -u +%Y-%m-%d))" --fill
MSG
