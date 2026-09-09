# Agent-owned upstream integration

- Reviewed base: `fb6f88fa65308e0f3161b63cbdcda96aab9b07f0`.
- Existing merge source: `6211fd261ee19c91dee4cb9c24894663e6c53b08`.
- Next reviewed upstream target: `f5157e8b992c5144ad935df7798733f0b20f3239`.
  Complete the existing merge before adding this newer upstream revision.
- Scope: complete the interrupted upstream integration, fix its generation
  prerequisites, and codify agent ownership through verified promotion. Deployment
  is separate. Preserve ancestry, reviewed source, and existing working changes.
- Root cause: schema repair incorrectly applies the strict committed-candidate
  baseline rule and reads the committed dependency pin during worktree repair.
  The sync helper also puts long-lived review work under a temporary directory.

## Acceptance and verification

- [x] Reproduce baseline/pin and worktree-location failures before code changes.
- [x] Repair regeneration without weakening strict revision verification; test
  actual entry-point behavior, history protection, and malformed inputs.
- [x] Place new candidates in predictable sibling worktrees; test real Git merges,
  collisions, original-checkout preservation, and promotion refusal without CI.
- [ ] Review upstream authored changes and generate all four database artifacts in
  newly allocated infrastructure. Rebuild source contracts from reconciled inputs.
- [ ] Run index preflight, repeated generation, applicable lint/tests/types, and
  strict fresh/upgrade schema verification for the committed candidate.
- [ ] Verify policy installation and an independent agent cold-read.
- [ ] Publish the reviewed candidate, require exact-SHA `fork-verified`, then
  fast-forward local `saturn/main`. Preserve normal protection and hooks.

Execution evidence and final remote verification belong in ignored `.fork/local/`
and GitHub Actions, so recording a passing SHA does not create an unverified SHA.
