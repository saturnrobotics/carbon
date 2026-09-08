#!/usr/bin/env bash
# Maintain the shared deployment branch without rewriting published history.
set -euo pipefail

deployment_branch="saturn/main"
deployment_ref="refs/heads/$deployment_branch"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"

usage() {
  cat <<'HELP'
Usage: bash contrib/deploying/gcp-tailscale/fork.sh <command>

  feature <branch>  Create and switch to a feature branch from clean saturn/main.
  finish <branch>   Promote a verified descendant to saturn/main (fast-forward only).
  promote <branch>  Same as finish; require successful fork verification for its SHA.
  sync              Merge upstream/main in a new sync branch and separate worktree.

Sync preserves saturn/main, including when conflicts occur. Review and verify the
candidate before promotion. Merges run normal Git hooks and stop on conflicts.
No command pushes, deploys, deletes branches, or rewrites commits. Keep private inputs in ignored
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
  feature|finish|promote)
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
if [[ "$command" != "finish" && "$command" != "promote" && "$current_branch" != "$deployment_branch" ]]; then
  fail "Run 'git switch saturn/main' first."
fi

preflight() {
  local checkout="$1"
  shift
  [[ -f "$checkout/.fork/verify.py" ]] || fail "Fork preflight is missing; integrate the fork safeguards before continuing."
  (cd "$checkout" && python3 .fork/verify.py preflight "$@")
}

case "$command" in
  feature)
    git switch -c "$branch" "$deployment_ref"
    printf '\nFeature branch created from %s. Commit and verify it before running fork.sh finish.\n' "$deployment_branch"
    ;;
  finish|promote)
    feature_ref="refs/heads/$branch"
    git show-ref --verify --quiet "$feature_ref" || fail "That local feature branch does not exist."
    candidate="$(git rev-parse "$feature_ref")"
    stable="$(git rev-parse "$deployment_ref")"
    git merge-base --is-ancestor "$stable" "$candidate" || fail "Candidate must include the current saturn/main; merge it into the candidate and verify the new revision first."
    preflight "$repo_root" --revision "$candidate" --base "$stable"
    python3 "$script_dir/verify_source.py" --repo "$repo_root" --revision "$candidate" --branch "$branch"
    [[ "$(git rev-parse "$deployment_ref")" == "$stable" ]] || fail "saturn/main changed during verification; retry after reviewing the new base."
    git switch "$deployment_branch"
    git merge --ff-only "$candidate"
    printf '\nPromoted verified revision %s to %s.\n' "$candidate" "$deployment_branch"
    ;;
  sync)
    preflight "$repo_root" --revision HEAD
    git remote get-url upstream >/dev/null 2>&1 || fail "Configure upstream first: git remote add upstream https://github.com/crbnos/carbon.git"
    git fetch --no-tags upstream refs/heads/main:refs/remotes/upstream/main
    stable="$(git rev-parse "$deployment_ref")"
    upstream="$(git rev-parse refs/remotes/upstream/main)"
    if git merge-base --is-ancestor "$upstream" "$stable"; then
      printf '%s already contains upstream/main.\n' "$deployment_branch"
      exit 0
    fi
    git merge-base "$stable" "$upstream" >/dev/null || fail "The branches have no common history; inspect them before merging."
    candidate_branch="sync/upstream-${upstream:0:12}-${stable:0:12}"
    if git show-ref --verify --quiet "refs/heads/$candidate_branch"; then
      fail "Sync candidate $candidate_branch already exists; inspect its worktree instead of creating another integration."
    fi
    candidate_worktree="$(mktemp -d "${TMPDIR:-/tmp}/carbon-upstream-sync.XXXXXXXX")"
    git worktree add -b "$candidate_branch" "$candidate_worktree" "$stable"
    printf '\nSync candidate: %s\nSync worktree: %s\n' "$candidate_branch" "$candidate_worktree"
    if ! git -C "$candidate_worktree" merge --no-ff --no-edit "$upstream"; then
      printf '\nMerge did not finish in %s. Resolve and verify there, or abort that worktree merge. saturn/main is unchanged.\n' "$candidate_worktree" >&2
      exit 1
    fi
    preflight "$candidate_worktree" --revision HEAD --base "$stable"
    printf '\nReview generated changes in the candidate, commit them, and submit its exact revision for Fork verification.\n'
    printf 'After fork-verified succeeds, run from your clean checkout: bash contrib/deploying/gcp-tailscale/fork.sh promote %s\n' "$candidate_branch"
    ;;
esac
