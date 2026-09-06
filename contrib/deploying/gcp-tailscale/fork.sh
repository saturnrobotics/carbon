#!/usr/bin/env bash
# Maintain the shared deployment branch without rewriting published history.
set -euo pipefail

deployment_branch="saturn/main"
deployment_ref="refs/heads/$deployment_branch"

usage() {
  cat <<'HELP'
Usage: bash contrib/deploying/gcp-tailscale/fork.sh <command>

  feature <branch>  Create and switch to a feature branch from clean saturn/main.
  finish <branch>   Switch to saturn/main and merge a reviewed local feature branch.
  sync              Fetch upstream/main and merge it into clean saturn/main.

Run package checks and review public source before finish, after sync, and before
make deploy. Merges run normal Git hooks and stop on conflicts. No command pushes,
deploys, deletes branches, or rewrites commits. Keep private inputs in ignored
contrib/deploying/gcp-tailscale/.local/ files.
HELP
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [[ "${1:-}" == "--help" || "${2:-}" == "--help" ]]; then
  usage
  exit 0
fi

command="${1:-}"
case "$command" in
  feature|finish)
    [[ $# -eq 2 ]] || fail "Use '$command <branch>'. See --help."
    branch="$2"
    # Reject revision shortcuts and reserved integration branches before any switch.
    normalized="$(git check-ref-format --branch "$branch" 2>/dev/null)" || fail "Invalid feature branch name."
    [[ "$normalized" == "$branch" && "$branch" != "$deployment_branch" && "$branch" != "main" ]] || fail "Choose a feature branch distinct from main and saturn/main."
    ;;
  sync)
    [[ $# -eq 1 ]] || fail "The sync command takes no arguments. See --help."
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

for operation in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  if [[ -e "$(git rev-parse --git-path "$operation")" ]]; then
    fail "Finish or abort the existing Git operation first."
  fi
done
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail "Working tree must be clean, including untracked files. Review and commit your changes first."
git show-ref --verify --quiet "$deployment_ref" || fail "The local saturn/main branch is missing; create it from the reviewed fork revision first."

current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ "$command" != "finish" && "$current_branch" != "$deployment_branch" ]]; then
  fail "Run 'git switch saturn/main' first."
fi

merge_branch() {
  local target_ref="$1"
  local target_label="$2"
  if git merge-base --is-ancestor "$target_ref" HEAD; then
    printf '%s already contains %s.\n' "$deployment_branch" "$target_label"
    return
  fi
  git merge-base HEAD "$target_ref" >/dev/null || fail "The branches have no common history; inspect them before merging."
  if ! git merge --no-ff --no-edit "$target_ref"; then
    printf '\nMerge did not finish on %s. Inspect git status, resolve and verify before committing, or run git merge --abort if a merge is pending.\n' "$deployment_branch" >&2
    exit 1
  fi
}

case "$command" in
  feature)
    git switch -c "$branch" "$deployment_ref"
    printf '\nFeature branch created from %s. Commit and verify it before running fork.sh finish.\n' "$deployment_branch"
    ;;
  finish)
    feature_ref="refs/heads/$branch"
    git show-ref --verify --quiet "$feature_ref" || fail "That local feature branch does not exist."
    git merge-base "$deployment_ref" "$feature_ref" >/dev/null || fail "The feature and deployment branches have no common history."
    git switch "$deployment_branch"
    merge_branch "$feature_ref" "$branch"
    printf '\nNext: bash contrib/deploying/gcp-tailscale/fork.sh sync\n'
    ;;
  sync)
    git remote get-url upstream >/dev/null 2>&1 || fail "Configure upstream first: git remote add upstream https://github.com/crbnos/carbon.git"
    git fetch --no-tags upstream refs/heads/main:refs/remotes/upstream/main
    merge_branch refs/remotes/upstream/main upstream/main
    printf '\nReview the merged source and run the relevant checks, then run make deploy.\n'
    ;;
esac
