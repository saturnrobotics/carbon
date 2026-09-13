# Rerere resolves the hunk, not the test

**Context:** Building Task 18 on four merged knowledge branches. Git rerere
auto-staged resolutions for four conflicted files, and the one remaining
conflict was resolved by hand.

**Problem:** The merge "succeeded" and the first `turbo run typecheck` showed one
package failing, so the others were never checked: turbo stops at the first
failure. A test on the merged-in side (`http.test.ts`) still asserted the
pre-merge error message, and three identity fixtures lacked a field the other
side had made required. None of that is a conflict marker, so nothing flagged
it until each package was typechecked and tested on its own.

**Rule:** After any merge, and especially after rerere restores a resolution,
diff each auto-resolved file against BOTH parents before keeping it, then run
every touched package's typecheck and tests separately (or `--continue`) so a
first failure cannot hide the rest. Treat "the merge applied" and "the merged
tests are green" as two different claims.

**Applies to:** every multi-branch integration on this fork (`feat/knowledge-*`
stacks, `integration/knowledge-platform`), and any repository with rerere
enabled.
