# Restore automatic upstream integration

Base: `b07db8ca61b052b4a81dd590dcc9cd957c801a09`.
Upstream: `6e519ed2982c48ae65b1510c8979029bbe5a4806`.

- [x] Reproduce the controller stop and preserve the previous idle candidate.
- [x] Prove the controller accepts independently derived clean generator-helper merges while rejecting worker changes and genuine control changes.
- [x] Reconcile authored inputs, preserving fork behavior and upstream features.
- [x] Regenerate database, MCP, knowledge and locale outputs with owned pinned tools.
- [ ] Run scoped regression checks, disposable schema upgrade/fresh checks and exact-revision fork CI.
- [ ] Promote the verified integration and verify the normal sync entry point.
- [ ] Deploy through the normal maintenance and health verification flow.

Protected upstream workflow changes and conflicting generator sources receive coordinator review outside the repair worker. The older saved candidate remains preserved; it must not be mistaken for the current verified integration. Runtime configuration and execution logs remain ignored.

## Pre-publication evidence

The controller regression suite includes the reported clean-merge case, preserved
fork customizations, subsequent upstream updates and adversarial content/mode/path
cases. Independent review found and repaired missing directory protection for
excluded helper-shaped files under `docs/lib/`. The 62 controller cases and three
policy/installer fixtures passed. Full operator and fork suites passed 282 and
152 cases respectively. ERP unit checks passed 4,329 cases. An owned disposable
accounting database executed 24 transaction/concurrency cases without skips.

The eight incoming migrations preserve every historical baseline migration.
Disposable regeneration succeeded; strict committed fresh/upgrade verification
and exact-revision CI remain promotion gates. All 372 incoming untranslated
strings were filled without replacing existing translations. Source coverage and
translation completeness pass; existing glossary inconsistencies are outside
this integration's terminology changes.

The stopped older candidate and private evidence remain available. Promotion and
deployment receipts, including their final revision, are recorded by the normal
operators outside tracked source after these gates succeed.
