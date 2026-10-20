# Docker image and build-cache pruning on the data disk

Base: `saturn/main` at `91249d344e`. Every file is fork-owned under
`contrib/deploying/gcp-tailscale/`; no upstream file is touched.

Docker's data-root, `/var/lib/carbon/docker`, shares the data disk with
PostgreSQL. Every maintenance release builds the ERP, MES and `ops` images on
the VM, and nothing removed old ones. An installation's data disk crossed its
80% alert with tens of unused images and over 100 GB of build cache,
including history carried over with the disk from an earlier host.

Choices:

- **Prune only after a published receipt.** `deploy.py` runs the new host
  action `prune` after `finalize` returns. A failed check, cleanup or
  finalization, and a no-op release, prune nothing. A pruning failure prints a
  warning and does not fail the release it follows: the receipt is already the
  baseline, and finalization keeps its single meaning.
- **Keep rule.** Removed: every image no keep reference names. Kept: every
  container's image (running or stopped); the last `DOCKER_KEEP_RELEASES`
  (default 2) successful releases; the current manifest; the images in
  `runtime/compose.json`, `previous-compose.json` and
  `routine-previous-compose.json`, which routine and maintenance rollback start
  from; and every prepared Compose definition newer than the manifest (a
  deployment in progress or a failed one awaiting recovery, released by the
  next success). A release keeps its app images by ID and by
  `carbon/<app>:<source_commit>` (what reuse and `rollback_plan` attest),
  `carbon/ops:<revision>`, and its Compose images, third-party ones included.
- **Release history.** The manifest holds only the latest release, so
  `finalize` writes `runtime/release-history/<generation>.json` (generation,
  revision, app image IDs and source commits, Compose image references; no
  configuration) before the receipt. A history failure therefore leaves the
  previous receipt published. The first release with history also records the
  one it replaces from the old manifest and `runtime/revision`. Until then the
  runtime Compose definitions stand in for the previous release.
- **Removal by ID, never forced.** Docker still refuses an image a container
  uses. A tag that moves to a new build during an on-demand prune is never
  removed, because only image IDs listed before the keep set was computed are
  candidates. A refusal is reported and the rest continue; the exit status is 1.
- **Fail closed.** No manifest, an unreadable record or Compose file, or any
  Docker answer other than "No such image" while resolving a kept reference
  stops pruning before anything is removed. Prune holds the finalize lock
  (`runtime/.release-manifest.lock`).
- **Build cache by age: `docker builder prune --force --filter until=72h`.**
  Pruning follows a release whose build has just used the dependency layers and
  package cache the next build reuses, so only superseded builds' entries go.
  A size cap would need a tuned number: too small drops the live dependency
  layer and makes the next build cold, too large frees nothing. Its flag also
  changed (`--keep-storage` is absent from buildx 0.35, which has
  `--reserved-space`, `--max-used-space` and `--min-free-space`), while both
  the classic builder and buildx accept `until`. Cost: after
  three days without a build, a release that builds nothing removes the last
  build's cache, and the next build is cold, never wrong. Images are removed
  first, because cache records shared with an image are not reclaimable.
- **Guard.** `prepare` runs `docker_prune.py guard` before rendering whenever
  the release builds an app or `ops` image. It refuses below
  `DOCKER_BUILD_MIN_FREE_GB` (default 15; GB = 2^30 bytes, as `df -h` and GCP
  count), measured as `f_bavail`: the space PostgreSQL, which is not root, can
  use. Nothing is built or stopped. A release that builds nothing is not
  checked.
- **On demand.** `host-deploy.sh … prune` and `prune-plan` (prints the same
  decision, removes nothing), run from the last successful release's
  directory; README "Disk usage and pruning" has the commands.
- **Settings.** `DOCKER_KEEP_RELEASES` (1–20) and `DOCKER_BUILD_MIN_FREE_GB`
  (1–10000) are optional integers, validated on the laptop and on the host.
  They are excluded from maintenance inputs, so changing them selects no
  maintenance. Volumes, containers, source releases and `prepared/` are never
  pruned.
- **Both ingress modes.** Pruning and the guard do not depend on the ingress, so
  they apply to `tailscale` and `private-lb` alike. Rendered stacks and service
  fingerprints are unchanged (no renderer input changed). `host-deploy.sh` is a
  maintenance input, so the first deployment of this change selects maintenance
  once in either mode.

Verification (local, 2026-10-20):

- The deployment tooling suite passes (321 tests, 302 before) under CI's pins
  on Python 3.13 and on CI's Python 3.12 (PyYAML 6.0.2), as do `ruff check
  contrib/deploying` (Ruff 0.4.1), ShellCheck on every script in the
  directory, `bash -n` and `git diff --check`.
- `test_docker_prune.py` runs pruning against a synthetic Docker CLI that
  answers the exact argv the module sends: three releases with history, a
  superseded failed deployment, a newer failed one, a running and a stopped
  container, dangling and third-party images. It covers N=1, 2 and 3, a VM
  without history, a later success releasing a failed deployment's images,
  dry run, a refused removal, and fail-closed cases (no manifest, invalid
  history, unreadable Compose, daemon errors), each of which removes nothing.
- `host-deploy.sh` ran with its state directory moved to a temporary one and
  stub host commands. `prepare` refuses below the threshold before any Docker
  call, for app builds and for maintenance (`ops`) builds alike. It skips the
  guard when nothing is built. `prune` and `prune-plan` give the same output
  with the mode key absent, `tailscale` or `private-lb`.
- Removing each safeguard makes tests fail: the guard call, the
  prepared-since-success rule, the history keep, the container keep, the
  finalize record, and the non-fatal post-release prune.
- Docker CLI contracts, read without changing the local daemon (Docker 29.6.1,
  buildx 0.35): `docker builder prune` is `docker buildx prune` and takes
  `--force` and `--filter`. A missing reference answers `Error response from
  daemon: No such image: …` with exit status 1.

Limits: no Docker daemon removed anything here. A disposable daemon needs a
privileged container on the shared local Docker, which this task did not
authorize. Removal by ID, the `until` filter's effect, and the VM's
installed buildx version are therefore unobserved. The bounded platform check
is the operator's first `prune-plan`, then `prune`, on the VM. Docker refuses
to remove an image tagged in several repositories without force; such an image
is kept and reported every time until an operator removes it.
