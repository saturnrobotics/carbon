#!/usr/bin/env bash
# Shared definitions for the fork-sync scripts. Source it; do not execute it.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Every script resolves the repository root itself, so all of them can be run
# from any directory.

set -euo pipefail

# The fork's integration and deployment branch. Upstream lands here only through
# a reviewed pull request from a sync/upstream-* branch.
FORK_TRUNK="${FORK_TRUNK:-saturn/main}"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/crbnos/carbon.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"

# Name of the custom merge driver that makes generated files take upstream's
# version instead of conflicting. Registered by setup-git.sh, used by .gitattributes.
REGEN_DRIVER="regen"

log() { printf '\033[1;34m»\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

fork_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || die "Not inside a git repository."
}

# Print every tracked path whose merge attribute is the regen driver, one per line.
# Reads .gitattributes through git itself so globs are expanded exactly as git does.
regen_paths() {
  git ls-files | git check-attr --stdin merge |
    awk -v driver="$REGEN_DRIVER" -F': merge: ' '$2 == driver { print $1 }'
}

# Print the short SHA of a ref.
short_sha() { git rev-parse --short=10 "$1"; }
