# Repair the upstream instruction guard

Reviewed base: `6d5dfb8919b0b1bff6a04f117660812cffa9d306`.
Paused upstream revision: `78239f8bf8a1f9c83efee1e7ce35cc35c6319009`.

- [x] Reproduce ordinary upstream documentation being rejected and a renamed
  verification file escaping the guard, using real Git fixtures.
- [x] Permit only exact pinned-upstream regular Markdown with no fork-specific
  modifications; retain protection for all control code and policy.
- [x] Review the incoming knowledge generator relocation separately and update
  its registered transitive inputs. Preserve the paused merge and original checkout.
- [ ] Run controller and safeguard regressions, strict lint, all source-generation
  groups, and independent review; publish the candidate for exact-revision CI.
- [ ] Promote only after fork verification passes, archive the externally resolved
  paused run with its evidence, and exercise make sync from the original checkout.

Raw logs and local worktree paths remain outside tracked source.

Local evidence: 45 controller fixtures, 152 safeguard fixtures, all 216 operator
fixtures, docs typecheck/build, and all four non-schema generation groups passed.
Independent controller review found no must-fix issues.
