#!/usr/bin/env bash
# Fork drift report: how far this fork is from upstream, and which files keep
# conflicting. This is the number to keep small.
#
#   bash scripts/fork/drift.sh [ref]     (default: the fork trunk; use HEAD for a branch)
#
# Prints: total files/lines changed vs upstream/<branch>, the 20 shared upstream
# files with the most changed lines, and the files that conflicted in the last 5
# upstream merge commits (from merge messages and the rerere cache when present).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$(fork_repo_root)"

ref="${1:-$FORK_TRUNK}"
up="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git rev-parse --verify --quiet "$up" >/dev/null || die "Missing $up; run: git fetch $UPSTREAM_REMOTE"

echo "# Fork drift: $ref ($(short_sha "$ref")) vs $up ($(short_sha "$up")) — $(date -u +%Y-%m-%d)"
echo
echo "## Totals (fork-side changes since the merge base)"
git diff "$up...$ref" --shortstat | sed 's/^ //'
added=$(git diff "$up...$ref" --name-only --diff-filter=A | wc -l | tr -d ' ')
modified=$(git diff "$up...$ref" --name-only --diff-filter=M | wc -l | tr -d ' ')
deleted=$(git diff "$up...$ref" --name-only --diff-filter=D | wc -l | tr -d ' ')
echo "fork-added files: $added · shared files modified: $modified · upstream files deleted: $deleted"
echo "upstream commits not yet merged: $(git rev-list --count "$ref..$up")"
echo
echo "## Top 20 shared upstream files by lines changed (added+deleted)"
printf '%-8s %-8s %-8s %s\n' lines added deleted path
git diff "$up...$ref" --numstat --diff-filter=M | awk '$1!="-"{printf "%d\t%s\t%s\t%s\n", $1+$2, $1, $2, $3}' |
  sort -rn | head -20 | awk -F'\t' '{printf "%-8s %-8s %-8s %s\n", $1, $2, $3, $4}'
echo
echo "## Files that conflicted in the last 5 upstream merges"
merges="$(git log --merges --format=%H -n 5 "$ref" -- 2>/dev/null || true)"
if [[ -z "$merges" ]]; then
  echo "(no merge commits on $ref yet)"
else
  found=0
  for m in $merges; do
    # `git merge` records "Conflicts:" followed by indented paths when the merge
    # message is kept; sync-upstream.sh / finish-sync.sh also write that block.
    conflicts="$(git log -1 --format=%B "$m" | awk '/^Conflicts:/{f=1;next} f&&/^\s+\S/{print $1} f&&!/^\s+\S/{f=0}')"
    if [[ -n "$conflicts" ]]; then
      found=1
      echo "$(git log -1 --format='%h %ad %s' --date=short "$m")"
      printf '%s\n' "$conflicts" | sed 's/^/    /'
    fi
  done
  (( found )) || echo "(none of the last 5 merges recorded conflicts)"
fi
if [[ -d "$(git rev-parse --git-path rr-cache)" ]] && [[ -n "$(ls -A "$(git rev-parse --git-path rr-cache)" 2>/dev/null)" ]]; then
  echo
  echo "## rerere cache: $(ls -1 "$(git rev-parse --git-path rr-cache)" | wc -l | tr -d ' ') recorded resolution(s)"
  git rerere status 2>/dev/null | sed 's/^/    /' || true
fi
