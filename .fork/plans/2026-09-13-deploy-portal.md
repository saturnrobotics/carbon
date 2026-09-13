# Single-command portal deployment

Implement `make deploy-portal` for the existing manual-v1 Cloud Run release.
Keep all target settings, logs and receipts in ignored `.local/` files. This task
implements and verifies tooling; it does not provision or deploy a live target.

- [x] Add offline-tested orchestration: validate private configuration, clean
  reviewed integration revision and CI; build from its Git archive for amd64;
  record registry digests; deploy schema, execute migrations, reread the live
  ledger, then release dependency-ordered workloads.
- [x] Correct controller job rendering/observation and verify the new revision's
  health before promotion without widening IAM. Persist successful progress.
- [x] Add Make targets, a synthetic setup template, missing-setup diagnostics,
  and instructions explaining first-time prerequisites and retry behavior.
- [x] Run deployment tests, static checks, Make entry-point checks and an
  independent review. Keep cloud behavior explicitly unverified until exercised
  on a configured target.

Verification: `python3 -m unittest discover -s contrib/deploying/portal -p
 'test_*.py'`, Ruff, `make -n deploy-portal`, and an actual configuration-free
invocation that must exit nonzero before a provider call. Unit tests must prove
schema failure stops promotion, the ledger is observed again after migration,
failed releases can retry, a no-op does not rebuild, and build context excludes
untracked and ignored private files. Existing portal CI runs the new tests.


Verified: 100 portal deployment Python tests, Ruff, changed JSON Biome,
Make entry points and the missing-configuration failure path. The latter stopped
before any provider call. Frozen offline install preserved the lockfile and
tracked generated outputs. An independent review checked rendered Cloud Run
resources against the official v1 API discovery schema and CLI command help.

Live rollout, rollback and workforce authorization remain unexecuted. First-time
setup still requires private inputs, operator credentials and the IAM grants
identified in the README. No cloud resources or authorization policies changed.
The inherited drift guard compares labels rather than reconstructing the entire
live resource. Builds reuse receipts on retry, but a new commit builds all six
images with layer caching. These limits are not claimed as completed pilot gates.
