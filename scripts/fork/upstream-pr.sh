#!/usr/bin/env bash
# Prepare an upstream contribution without dragging the fork's merge history along.
#
#   bash scripts/fork/upstream-pr.sh <branch-name> <commit>...
#
# Creates <branch-name> from upstream/main, cherry-picks the given fork commits
# onto it, and prints the `gh pr create --repo crbnos/carbon` command. It does not
# push; review the branch first. Requires a clean working tree.
set -euo pipefail
# shellcheck source=scripts/fork/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$(fork_repo_root)"

[[ $# -ge 2 ]] || die "usage: $0 <branch-name> <commit>..."
branch="$1"; shift
git check-ref-format --branch "$branch" >/dev/null || die "Invalid branch name: $branch"
[[ -z "$(git status --porcelain)" ]] || die "Working tree must be clean."
git show-ref --verify --quiet "refs/heads/$branch" && die "Branch $branch already exists."
for c in "$@"; do git rev-parse --verify --quiet "$c^{commit}" >/dev/null || die "Unknown commit: $c"; done

log "fetching $UPSTREAM_REMOTE"
git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
original="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
git switch --quiet -c "$branch" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
log "created $branch from $UPSTREAM_REMOTE/$UPSTREAM_BRANCH ($(short_sha "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"))"

if ! git cherry-pick -x "$@"; then
  warn "cherry-pick stopped on a conflict. Resolve it, then: git cherry-pick --continue"
  warn "or abandon with: git cherry-pick --abort && git switch $original && git branch -D $branch"
  exit 2
fi

log "cherry-picked $# commit(s):"
git log --oneline "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH..$branch" | sed 's/^/    /'
title="$(git log -1 --format=%s "$branch")"
cat <<MSG

Review the branch, then push it to your fork and open the upstream PR:

    git push -u origin $branch
    gh pr create --repo crbnos/carbon --base $UPSTREAM_BRANCH --head $(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#'):$branch \\
      --title "$title" --body "Contributed from the saturnrobotics/carbon fork."

Return to your previous branch with: git switch $original
MSG
