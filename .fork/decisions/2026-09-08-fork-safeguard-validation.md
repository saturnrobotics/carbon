# Fork safeguard verification

Candidate work began at `6b5f5c5944` on `fix/fork-safeguards` in an isolated worktree. The original checkout's existing lockfile edit was preserved. No deployment or upstream history rewrite was performed.

## Implemented enforcement

- Immutable Git preflight precedes dependency installation; hooks inspect the index before and after formatting.
- The registry assigns output ownership and required verification groups. Whole-pipeline repetition checks tracked and disposable output. Common environment files and declared local inputs are hashed to detect mutations without reporting their contents.
- DB generation validates temporary output and restores last-good files on replacement failure. Disposable schema checks verify migration identities, fresh/upgrade convergence, generator provenance, and committed artifacts.
- Fork-owned records and lessons live under `.fork/`; inherited records remain upstream-owned. Installer fixtures and independent cold reads verify persistent routing.
- Upstream sync uses an isolated branch. Promotion and deployment require successful verification for the exact candidate SHA.
- GitHub protection was applied and independently read back: strict `fork-verified` from GitHub Actions is required for `saturn/main`, including administrators; force pushes and deletion are blocked. Other existing requirements were preserved.

## Repair of inherited test assumptions

The batching guard tests referenced migrations consolidated by upstream `7775cd66bd`; their tenant/FK assertions now inspect the consolidated migration and Planned lifecycle. Upstream `7f5f1d2145` moved scheduling in-process; the status test now observes that call while retaining status-before-scheduling order. Upstream `82125ce1ef` added batch reprioritization; the lifecycle test asserts its payload and retains a self-drop no-op case. The MCP test now asserts all knowledge permission overrides explicitly. Accounting close fixtures now provide the timezone and external-integration reads made by the current service.

These six repaired suites pass. Production changes in this work are limited to safe generation and removal of the obsolete Inngest dispatcher overwrite/import; its regression exercises the actual route wiring.

The reviewed migration-built types and backup manifest were applied. The manifest now includes the three missing tables and new columns on five existing tables. Swagger was regenerated to include eleven missing table definitions, eighteen extraction fields, and the associated endpoints/parameters. Formatting preserves the repository's existing style. This regeneration repairs stale definitions; it does not resolve the cross-instance annotation instability described below.

Local checks passed: 103 safeguard Python tests without skips, 27 generator/dispatcher/canonicalization Node tests with `NODE_PATH` unset, 159 operator tests using disposable PostgreSQL and OpenSSL 3, and scoped ERP/jobs/database typechecks. The operator tests initially exposed the host's incompatible LibreSSL executable; they passed with OpenSSL 3, matching the Linux CI prerequisite. All allocated verification containers, volumes, and networks were removed.

The full non-schema generator pipeline passed two runs against the reviewed index (`source`, `knowledge`, `build`, and `routes`). The MCP generator's unused wall-clock timestamp was removed to make local metadata repeatable. Real generation also proved the verifier must handle recursive globs matching direct children and compare JSON semantics within mixed Markdown/JSON output groups; both now have negative fixtures. A final frozen install with lifecycle scripts succeeded using pnpm 10.33.4 and installed the fork policy skill.

Strict source lint checked all 19 selected TypeScript/JSON files plus the changed Python files. A real Git fixture confirms that previously tracked runtime files preserved locally after removal are excluded from the candidate's lint set. Disposable verification of committed `54eecb7c09` again matched SQL definitions, both type copies, and backup manifests, and failed only Swagger convergence. The subsequent lint-selection repair does not alter schema/generator inputs.

## Remaining release evidence

Initial validation reported 982 passing ERP tests and two failing localization checks. Both test files and the relevant implementation were unchanged from the merged upstream revision. One check rejected permitted breadcrumb `msg` descriptors; the other labeled text inside `<Trans>` as untranslated and also found a real untranslated Tax Status label. Those failures were preserved until the user authorized the focused repairs described in [the repair record](2026-09-08-blocker-repairs.md). The repaired ERP suite has 1,016 passing tests, with a separately required browser locale-switch regression.

Initial disposable verification applied all 1,000 migrations on fresh and upgrade paths. Full schema fingerprints, DB types, and backup artifacts converged, while Swagger differed between independently booted PostgREST instances in the inferred primary-key annotation for the `partners` view. The repair corrects that known producer variation after actual catalog proof; strict comparison of semantic metadata remains enabled.

The candidate remains unpromoted until every required application/schema/invoice/knowledge check succeeds for its exact SHA. The scheduled dispatcher must be installed on the repository default branch to become active; committing it only on another branch does not activate GitHub's schedule. No local fixture result is a substitute for that live CI evidence.
