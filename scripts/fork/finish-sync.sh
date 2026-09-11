#!/usr/bin/env bash
# Finish an upstream merge that stopped on conflicts (see sync-upstream.sh).
#
#   bash scripts/fork/finish-sync.sh
#
# Run on the sync/upstream-* branch after resolving and `git add`-ing every
# conflicted file. Verifies no conflict markers remain, regenerates the generated
# files, runs the migration guard, commits, and prints the next steps.
set -euo pipefail
# shellcheck source=scripts/fork/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(fork_repo_root)"

merge_head="$(git rev-parse --git-path MERGE_HEAD)"
[[ -f "$merge_head" ]] || die "No merge in progress. Start one with scripts/fork/sync-upstream.sh."
branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ "$branch" == sync/* ]] || die "Expected to be on a sync/* branch (currently '${branch:-detached HEAD}')."
target="$(cat "$merge_head")"
target_short="$(git rev-parse --short=10 "$target")"
trunk_sha="$(git rev-parse HEAD)"

unresolved="$(git diff --name-only --diff-filter=U)"
[[ -z "$unresolved" ]] || { printf '%s\n' "$unresolved" | sed 's/^/    /' >&2; die "Unresolved files above: resolve and git add them first."; }
# `git diff --check` also flags trailing whitespace, and upstream files carry
# some; only leftover conflict markers are a reason to stop here.
if git diff --cached --check 2>/dev/null | grep -q "leftover conflict marker"; then
  git diff --cached --check 2>/dev/null | grep "leftover conflict marker" >&2
  die "Conflict markers remain in the staged changes."
fi
markers="$(git grep -n -E '^(<<<<<<< |>>>>>>> |=======$|\|\|\|\|\|\|\| )' -- ':!*.po' ':!**/*.snap' 2>/dev/null | head -20 || true)"
if [[ -n "$markers" ]]; then
  printf '%s\n' "$markers" >&2
  die "Conflict markers remain in the working tree (see above)."
fi

log "regenerating generated files from the merged sources"
bash "$here/regenerate.sh"
bash "$here/check-migrations.sh" "$FORK_TRUNK" || die "migration check failed"

pending="$(git rev-list --count "$trunk_sha..$target")"
# sync-upstream.sh left the conflicted-file list here; record it in the merge
# commit ("Conflicts:" block, the format git itself uses) so drift.sh can report it.
conflicts_file="$(git rev-parse --git-path fork-sync-conflicts)"
conflicts_msg=""
if [[ -s "$conflicts_file" ]]; then
  conflicts_msg="$(printf 'Conflicts:\n'; sed 's/^/\t/' "$conflicts_file")"
fi
git commit --quiet -m "Merge $UPSTREAM_REMOTE/$UPSTREAM_BRANCH ($target_short) into $FORK_TRUNK" \
  -m "$pending upstream commit(s): $(git rev-parse --short=10 "$trunk_sha")..$target_short" \
  -m "Conflicts resolved by hand; generated files regenerated with scripts/fork/regenerate.sh." \
  ${conflicts_msg:+-m "$conflicts_msg"}
rm -f "$conflicts_file"
log "committed $(git rev-parse --short=10 HEAD) on $branch"
cat <<MSG

Next steps:
    pnpm exec biome check && pnpm run typegen && pnpm run typecheck && pnpm test
    git push -u origin $branch
    gh pr create --base $FORK_TRUNK --head $branch --label upstream-sync \\
      --title "Sync upstream $target_short ($(date -u +%Y-%m-%d))" --fill
MSG
