# Check history and actual build contexts for private artifacts

Context → Generated provider binaries and Python caches entered local history;
some files were later deleted, but old commits still retained them. Compiled
Python caches can embed private absolute paths even when their source is generic.

Problem → A clean working tree and root ignore rules do not establish privacy.
Already tracked files remain in Git archives. Nested Git rules can re-include an
environment file, and Dockerfile-specific rules or a different context root can
bypass the repository's main Docker exclusions.

Rule → Scan immutable tracked content and relevant history. Keep private runtime
inputs and generated artifacts ignored, and reject forced tracking through the
preflight gate. Preserve reviewed empty templates and infrastructure source.
Test every supported Docker ignore/context configuration with synthetic private
and public fixtures. Review and verify authorized history cleanup separately from
current-tree changes; keep raw findings outside tracked source and never echo
credential values. Distinguish fork-origin leaks from inherited public history
before changing upstream ancestry.

Inventory refs by object type: agent snapshot refs can point directly to trees,
which commit-oriented rewrite tools may skip. Account for linked-worktree indexes,
HEAD reflogs and recovery pointers. Examine dropped staging snapshots before
pruning; retain sanitized recovery refs when unique work cannot be ruled out.
Verify actual object removal after cleanup, in addition to ref reachability.

Applies to → Agent commits, Terraform and Docker workflows, source archives,
fork privacy reviews, and authorized local history cleanup.
