# Private history and artifact cleanup

The user explicitly authorized scanning the integration branch and removing
accidentally committed private material from local history before publication.
This targeted cleanup authorization supersedes the ordinary prohibition on
rewriting integration history. It grants no publication or deployment permission.

## Plan

- [x] Scan the current tracked tree and reachable history using secret detection,
  artifact inventories, and comparison with local deployment identifiers. Review
  findings without copying sensitive values into public records or tool output.
- [x] Add tested Git and Docker exclusions for private inputs and generated
  artifacts, preserving reusable infrastructure source and generic examples.
  Reject forced tracking of prohibited artifacts in the existing preflight gate.
- [x] Prepare any required history rewrite in an isolated repository. Preserve
  upstream ancestry and source behavior. Include old local refs that could retain
  identified material; keep operational local files intact.
- [x] Rescan the rewritten history and tree, verify exact intended differences,
  and run the relevant safeguard and build-context checks. Apply only the reviewed
  rewrite to local branches, then verify worktrees and local object retention.

Verification accounted for all commit refs, direct tree refs used by agent
snapshots, linked-worktree recovery pointers and indexes, and dropped staging
snapshots. Ten sanitized recovery refs preserve older work whose supersession
could not be established. After pruning, all nineteen distinct artifact blobs
were unavailable in the local Git object database, Git integrity passed, and all
four worktrees were clean. Public upstream ancestry remains intact.

Raw findings, original data, and rewrite mappings belong only in a restricted
audit directory outside tracked source. Public findings must name categories and
generic paths without repeating sensitive values. Do not claim that a clean
pattern scan proves the absence of every possible secret or private fact.
