# Generator helpers and sync authority

**Context:** Routine upstream MCP generator changes stopped the automated sync
before its first repair turn because `scripts/` was protected as control code.

**Problem:** Removing directory protection would let the worker change checks.
Accepting the upstream file verbatim would discard cleanly merged fork behavior.
Using the current index as authorization would trust worker-controlled state.

**Rule:** Protect control directories independently from exemption eligibility.
For baseline-registered implementation helpers, derive the expected conflict-free
merge from immutable fork, ancestor and upstream blobs; require matching HEAD,
index, raw working bytes and regular non-executable file modes. Keep conflicts,
entry points, tests, installers and registry changes under coordinator review.
Test excluded helper-shaped files in every supported directory, including
`docs/lib/`, and test fork-customized clean merges across subsequent updates.

**Applies to:** Sync controller authority checks and future generator registration.
This content guard does not sandbox dependency lifecycle scripts or turn local
execution of trusted upstream source into a hostile-code security boundary.
