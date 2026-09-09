# Selective deployment and stable build inputs

Reviewed base: `3bd174e0e45d4637e03caf082232263888160556`.

Scope: improve the existing service release controller, without deploying or
changing production configuration. Preserve conservative maintenance for uncertain
database, authentication, and platform changes. Upstream ancestry and skipped
deployments are handled against each service's last successful content receipt.

- [x] Reproduce unnecessary shared build/configuration invalidation with real
  dependency and Git fixtures; add negative unknown-input coverage.
- [x] Scope effective build inputs and report changed components/paths; preserve
  service provenance, deleted dependencies, and failed-release baselines.
- [x] Compare effective app/platform configuration; separate image preparation
  from required maintenance and verify actual host build/rollout commands.
- [x] Pin Node image digests in reviewed source; preserve dependency/cache layers
  across application source edits and verify actual container builds.
- [x] Inspect existing deployment baseline read-only without exposing private data.
- [x] Run scoped regressions, strict lint, generated comparisons, and independent
  review. Document evidence and limitations.

Local evidence: 264 deployment/operator tests and 152 safeguard tests passed;
source/knowledge/build/routes generated groups matched the reviewed index. Actual
ERP and MES production images built, generated runtime assets were present, and
the Docker dependency cache proof passed. A real first-run isolated Python
bootstrap passed. Production observation was read-only.

Promotion still requires successful applicable CI for the resulting commit. The
GitHub `fork-verified` check on that exact SHA is the authoritative CI receipt;
local checks alone do not authorize promotion or deployment.

Raw logs, runtime state and private configuration remain in ignored local storage.
