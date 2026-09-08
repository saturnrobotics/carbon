# Fork safeguards implementation

Spec: `.fork/specs/2026-09-08-fork-safeguards.md`. Base: `6b5f5c5944`. Branch: `fix/fork-safeguards`.
The user authorized implementation of the audited recommendations. Fork-owned paths replace upstream `.ai/` artifact paths for this work.

## Progress
- [x] 1. Add tested Git-snapshot preflight, artifact registry, generator verification, and integration CI.
- [x] 2. Make DB generation failure-safe; correct MCP generation/cache and repair digest.
- [x] 3. Codify persistent agent policy and migrate fork-owned records; verify installer and cold-read behavior.
- [x] 4. Enforce exact-revision release verification and isolated upstream synchronization, with failure-injection tests.
- [x] 5. Add disposable schema provenance/upgrade verification and tracking hygiene checks.
- [ ] 6. Run fresh-install/generation checks, scoped tests, integration fixtures and independent review; preserve the original workspace diff.

## Task 1
Files: `.fork/verify.py`, `.fork/generated-artifacts.json`, `.fork/tests/test_verify.py`, `.github/workflows/fork-check.yml`, `package.json`, `.gitignore`.
Implement stdlib Python Git snapshot validation (HEAD, index, working tree), clean generation comparison against a captured baseline, repeatability, and explicit failure results. Pin dependency manager to packageManager; frozen installation is mandatory. Keep the lockfile during clean. CI preflight precedes installation. Verification: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .fork/tests -v` must collect and pass failure-injection cases.

## Task 2 (independent)
Files: `scripts/generate-db-types.ts`, dedicated generator test/helper under `scripts/lib/`, `turbo.json`, MCP digest. Write subprocess failure test first; generate and validate in temporary files before replacing outputs. Disable MCP caching until transitive input coverage is provable. Regenerate digest from the reconciled sources. Verify with `pnpm exec tsx --test scripts/lib/generate-db-types.test.ts` and `pnpm check:manifest`. Never connect to an existing DB for these tests.

## Task 3 (independent)
Files: `.fork/agent-policy.md`, `.fork/README.md`, fork record directories, `AGENTS.md`, `CLAUDE.md` if present, `.ai/scripts/install-skills.sh` only if required for routing, fork-maintenance skill. Preserve fork-only authored content and upstream instructions; place new records in `.fork/`. Use minimal stable upstream entry-point additions. Verify installer output in an isolated fixture and ask a fresh agent to follow the policy against synthetic conflict scenarios. No edits to generated `.codex/` sources.

## Task 4 (independent)
Files: `contrib/deploying/gcp-tailscale/fork.sh`, `test_fork.py`, `deploy.py`, source verification helper/tests, `WORKFLOW.md`. Sync in a separate branch, preserve upstream ancestry and clean original branch. Require successful fork-check workflow for the exact revision before deployment mutations; fail on missing, pending, skipped, failed, or wrong-revision results. Verify `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p 'test_fork.py'` plus scoped deployment/source verification suites. No real publication/deployment.

## Task 5 (after 1)
Files: `.fork/schema.py`, `.fork/tests/test_schema.py`, CI wiring. Use only newly allocated disposable verification infrastructure. Validate migration identities/content and schema convergence on fresh and upgrade paths; generate canonical artifacts there. Never reset/rebuild developer or production databases. Verify synthetic migration-drift and different-schema fixtures, then execute disposable integration when available.

## Task 6
Run generator and fork suites, relevant deployment tests, frozen fresh install, immutable baseline comparison, policy loading and malicious/corrupt fixture checks. Independently review the full diff. Run read-only whitespace and tracking checks, explicitly stage task files only, commit verified changes locally, and integrate without touching the user’s lockfile edits. Record exact checks and limitations in this plan.

## Verification and promotion status

See `.fork/decisions/2026-09-08-fork-safeguard-validation.md` for actual results and inherited failures. GitHub protection was applied and independently verified. Local safeguard/generator/operator suites and scoped typechecks passed; generated artifacts were rebuilt and reviewed. Independent reviewers found and helped close false-pass paths in CI, source snapshots, and disposable provenance.

Full promotion remains blocked by two existing ERP localization tests and nondeterministic Swagger primary-key annotations across otherwise identical disposable schemas. Keep those results failed and the implementation branch unpromoted; do not claim Task 6's integration requirement is complete until exact-SHA mandatory CI passes. No existing database was rebuilt, no source was published, and the original checkout's lockfile edit remains untouched.
