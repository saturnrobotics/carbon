# Docker pruning: remove images by tag, bound build cache by size

Base: `saturn/main` at `af20af3c72` (#91 merged). Every file is fork-owned
under `contrib/deploying/gcp-tailscale/`. This replaces two choices in
[2026-10-20-docker-prune.md](2026-10-20-docker-prune.md): removal by ID and
build cache by age. The keep rule, guard, release history and fail-closed
behavior are unchanged.

The first live prune after #91 freed nothing. Docker refused ten ERP, MES and
`ops` images by ID, each tagged for two commits ("conflict: unable to delete …
(must be forced)"). Build cache stood at over 100 GB, about 75 GB of it
reclaimable and all from that day's builds, so `until=72h` removed none of it,
and it held the layers of the images that were removed.

Choices:

- **Remove by tag.** An image nothing keeps is removed with
  `docker image rm <repo>:<tag>` for each of its tags, never forced; Docker
  deletes it with its last tag. An untagged image is removed by ID. An image
  carries several tags when a build whose inputs did not change (for example,
  a commit outside the build context) yields the same image under the new
  commit's tag.
- **Stale tags on kept images.** A kept image loses the tags no kept reference
  names, but only while one that a reference names remains. A kept image is
  never left untagged: a container's image, or one kept only by ID, keeps all
  its tags. References are compared in Docker's `RepoTags` form (`docker.io/`
  and `library/` dropped, `:latest` added). Which images are kept still comes
  from Docker resolving each reference.
- **Moved tags.** Before removing a tag, prune checks that it still names the
  listed image. A tag that moved to a newer build since listing is left alone
  and reported, which keeps #91's rule that nothing created after listing is a
  candidate. The window between that check and the removal remains.
- **Build cache by size: `docker builder prune --force --keep-storage <N>GB`.**
  `DOCKER_BUILD_CACHE_KEEP_GB`, default 20, range 1–10000, configured like
  `DOCKER_KEEP_RELEASES` and excluded from maintenance inputs. `--keep-storage`
  is the one size flag both the classic `docker builder prune` and buildx
  accept. buildx 0.17 and later keep it as a hidden, deprecated name for
  `--reserved-space`; #91's record called it absent from buildx 0.35, but that
  version accepts it with a deprecation notice. In BuildKit 0.17 and later, a
  reserved space alone becomes the prune's keep bound (`calculateKeepBytes`).
  Older BuildKit read the same field as its keep size. BuildKit removes
  unshared records one at a time, least recently and least often used first
  (`sortDeleteRecords`), until the total is under the bound. Records an image
  uses are neither counted nor removed, so images are removed first.
- **Why 20 GB.** A source-only build hits the cache only for the ERP and MES
  dependency installs (`deps` stage, 2.05–2.22 GB each in local
  `Dockerfile.saturn` builds), the `carbon-pnpm` store mount and the base
  images. Everything else is keyed on source and never matched again: the
  source copy, `turbo prune`, `pnpm run build`, and the `ops` install, which
  runs on the whole source. Every build uses the dependency layers, so they
  are removed last. 20 GB is about twice that working set, so the previous
  dependency set usually survives a lockfile change too. Below about 10 GB the
  next build can lose its dependency layers and reinstall each app from the
  registry. Above 20 GB the extra holds only superseded builds.
- **No age rule.** Both rules remove only unshared records. With a size bound,
  the age rule would add only one effect: after three days without a build, it
  would delete the cache the bound keeps for the next build, to free at most
  `DOCKER_BUILD_CACHE_KEEP_GB`.
- **Honest report.** Prune prints free space before and after and how much it
  freed. It warns on stderr when less than twice `DOCKER_BUILD_MIN_FREE_GB`
  remains, without changing the exit status. A refused removal, a moved tag or
  a failed cache prune is reported, the rest continues, and the exit status is
  1, which `deploy.py` reports as a warning.
- **`host-deploy.sh` unchanged.** It is a maintenance input, so even a comment
  change would select maintenance. Its comment on the `prune` action still
  says "build cache unused for 72 hours"; correct it with the next change that
  needs maintenance anyway.

Verification (local, 2026-10-20):

- The deployment tooling suite passes under CI's pins: 326 tests (321 before)
  on Python 3.13 with the workspace's `turbo` and `tsx` available. The prune
  and deploy tests also pass on Python 3.12. `ruff check contrib/deploying`
  (Ruff 0.4.1), ShellCheck on every script in the directory, `bash -n` and
  `git diff --check` pass.
- The synthetic Docker CLI now answers `image rm` as dockerd does without
  force. By ID, it removes only an image with at most one tag and no
  container. By tag, it untags, refuses the last tag of a container's image,
  and deletes the image with its last tag. New tests cover an image whose
  tags are all stale (removed), a kept image with one kept and one stale tag
  (only the stale tag goes), container images with unnamed tags (kept), a
  dangling image (by ID), a moved tag, the size-bounded prune and its setting,
  the free-space report and warning, and failures that still do the rest and
  exit 1.
- Mutation checks fail tests: removing tagged images by ID, untagging kept
  images without a named tag, skipping the moved-tag check, an age-only cache
  prune, no low-space warning, and a cache failure that aborts.
- CLI and BuildKit contracts were read without changing a daemon. Docker
  29.6.1 with buildx 0.35.0 accepts `docker buildx prune --keep-storage 1GB`
  and prints the deprecation notice on stdout. Read on GitHub: BuildKit
  `cache/manager.go`, buildx `commands/prune.go` and docker/cli
  `cli/command/builder/prune.go`. Local build cache was measured with
  `docker buildx du --verbose`.

Limits: no Docker daemon removed anything here. The effect shows on the VM's
next prune, which needs a release containing this change: on-demand pruning
runs the last successful release's tooling. The VM's BuildKit version was not
observed. The bootstrap installs current Docker Engine packages, which embed a
BuildKit newer than 0.17.
