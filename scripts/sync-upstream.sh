#!/usr/bin/env bash
# Prepare an upstream merge for review. Does not commit, push, or deploy.
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: bash scripts/sync-upstream.sh

Run from a clean, current main branch in your fork. Requires an upstream remote.
Fetches upstream/main, creates sync/upstream-<commit>, and prepares an uncommitted
merge for review. Resolve conflicts, verify, and commit the merge yourself.
HELP
  exit 0
fi

if [[ $# -ne 0 ]]; then
  printf 'Unexpected arguments. Use --help for usage.\n' >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  printf 'Working tree must be clean, including untracked files.\n' >&2
  exit 1
fi

for operation in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  if [[ -e "$(git rev-parse --git-path "$operation")" ]]; then
    printf 'Finish or abort the existing Git operation first.\n' >&2
    exit 1
  fi
done

if [[ "$(git symbolic-ref --quiet --short HEAD || true)" != "main" ]]; then
  printf 'Switch to your current main branch before preparing an upstream merge.\n' >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  printf 'Configure upstream first: git remote add upstream https://github.com/crbnos/carbon.git\n' >&2
  exit 1
fi

git fetch --no-tags upstream refs/heads/main:refs/remotes/upstream/main

if git merge-base --is-ancestor refs/remotes/upstream/main HEAD; then
  printf 'main already contains upstream/main.\n'
  exit 0
fi

if ! git merge-base HEAD refs/remotes/upstream/main >/dev/null; then
  printf 'main and upstream/main have no common history; inspect the upstream remote.\n' >&2
  exit 1
fi

upstream_commit="$(git rev-parse --short=12 refs/remotes/upstream/main)"
integration_branch="sync/upstream-${upstream_commit}"
if git show-ref --verify --quiet "refs/heads/$integration_branch"; then
  printf 'Review branch %s already exists. Inspect it before retrying.\n' "$integration_branch" >&2
  exit 1
fi

git switch -c "$integration_branch"
if ! git merge --no-commit --no-ff refs/remotes/upstream/main; then
  printf '\nMerge stopped on %s. Resolve conflicts and verify before committing, or run git merge --abort.\n' "$integration_branch" >&2
  exit 1
fi

printf '\nPrepared %s; main is unchanged. Review git diff --cached, verify, then commit.\n' "$integration_branch"
printf 'To discard the pending merge: git merge --abort, then git switch main.\n'
