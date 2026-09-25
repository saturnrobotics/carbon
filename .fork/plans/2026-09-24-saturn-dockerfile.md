# Separate fork images from the upstream Dockerfile

Base: `saturn/main` at `823ab1455d5f0eabec843f9030907eacd94c339c`.
Upstream Dockerfile source: `5ba005208b53584224d846ef8544225fe3781191`.

The root `Dockerfile` follows upstream exactly. Fork application and operations
images use `Dockerfile.saturn`, preserving reviewed Node digests, per-application
workspace pruning, dependency cache behavior, and the existing runtime contract.
Portal and assembler retain their independent Dockerfiles.

- [x] Prove failing regressions for explicit fork recipe selection and release
      selection when only the fork Dockerfile changes; verify reviewed pins.
- [x] Add `Dockerfile.saturn`; restore upstream `Dockerfile`; update build callers,
      release inputs, cache proof, and operator/fork documentation.
- [x] Verify Python and shell/workflow checks, Docker context privacy, dependency
      cache reuse, and real application/ops images with synthetic runtime inputs.
- [ ] Review the complete diff, commit, and open one independent PR targeting
      `saturn/main`. Leave the existing sync worktree untouched. Document merging
      trunk into PR #77 and resolving its already-committed Dockerfile markers
      with the upstream-owned copy; no rebase or force-push.

No production deployment or database migration is part of this change.
