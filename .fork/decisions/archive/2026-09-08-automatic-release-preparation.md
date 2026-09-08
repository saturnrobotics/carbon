# Automatic release preparation verification

- Implemented automatic desired manifest generation and read-only deployment preview; normal apply no longer reads a hand-written default manifest.
- Added complete ERP/MES inventory, observed secret content versions, repository build closures, immutable base references, maintenance classification, private atomic output, and source-revision consistency checks.
- Legacy deployments without a baseline automatically select coordinated maintenance through ordinary `make deploy`; observation failures never become first-install assumptions. The user clarified that deployment mode selection and baseline setup must not become operator homework.
- Offline command: `PATH="/opt/homebrew/opt/openssl@3/bin:$PATH" .local/verify-venv/bin/python -m unittest test_prepare_release test_deploy test_release_plan test_service_rollout test_base_images test_render` from the deployment directory. Result: 85 tests passed. The existing verification virtual environment supplies PyYAML; OpenSSL 3 supplies the existing TLS test's verify_ip capability.
- Real `make deploy-check` and read-only `make deploy-plan` succeeded. Private artifacts parse as JSON, have mode 600, include both managed services, contain immutable base references, and do not contain supplied credential values. Environment-specific output remains in ignored local logs.
- Bash syntax and scoped diff whitespace checks passed. Independent review findings for maintenance ownership, artifact protection and source revision races were fixed and covered by regression tests.
- No deployment, commit or source publication performed. Existing unrelated working-tree changes preserved.

## Single-command follow-up

- Ordinary `make deploy` now selects coordinated maintenance automatically for missing baselines or shared changes. Preview/check commands are optional diagnostics; force-maintenance remains a compatibility override.
- Added real controller lifecycle tests with external boundaries mocked: baseline setup and shared changes take prepare/quiesce/snapshot/start/maintenance/check in order; ERP-only updates avoid shared restarts; no-op avoids publication/provisioning.
- If creating the recovery snapshot fails, the controller restarts Docker and the previous service definitions, skips migration, and preserves the original failure. Both automatic selection and service recovery were observed failing before implementation and passing afterward.
- Final offline verification: the same scoped command above plus `test_deploy_lifecycle` passed all 89 tests. Bash syntax, Make target wiring and scoped diff whitespace checks passed. Real read-only preparation was repeated with the updated workflow; production mutation remains unperformed.
