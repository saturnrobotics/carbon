# CI selection and upstream integration

Base: `01e06f3cf43fef9c704609e95e321778386215a1`.

- [x] Add conservative, tested PR change classification before dependency installation. Preserve full trunk/dispatch checks and existing check names; unknown/shared inputs select all checks.
- [x] Replace the shared Install barrier with independent selected jobs and shared setup. Defer only root install-time generation in CI, preserve dependency build scripts, and invoke required font generation explicitly. Keep MCP generation in existing task dependencies.
- [x] Persist the Turbo build cache for the fixed unit-test environment; leave test/typecheck/generator execution uncached. Validate cache and setup inputs.
- [ ] Verify selector and lifecycle regressions, workflow syntax, scoped formatting, and review the complete diff. Open and merge the optimization PR after passing checks.
- [ ] Dispatch upstream-sync from updated trunk. Monitor failures, resolve the resulting integration conflicts in isolation, regenerate derived artifacts, and merge only after applicable gates pass.

Validation uses Python unittest for selection, Node's test runner for install lifecycle behavior, actionlint for workflows, scoped Biome for JavaScript/JSON, and actual GitHub checks. Local artifacts and execution evidence remain ignored. No production deployment is included.
