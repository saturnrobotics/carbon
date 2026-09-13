# Biome does not process `scripts/`, `ci/`, `.fork/` or package-root TypeScript

**Context:** Adding `packages/knowledge/scripts/validate-callers.ts` and running
the required `pnpm exec biome check --error-on-warnings` on it.

**Problem:** Biome printed `Checked 0 files` and, with `--verbose`, "These paths
were provided but ignored". The same happens for every existing
`packages/*/scripts/*.ts`, `scripts/lib/*.ts`, `ci/src/*.ts`, `.fork/*.ts` and
package-root files such as `vitest.config.ts`; only `apps/**`, `packages/*/src/**`
and JSON are processed. The cause is the upstream-owned `files.includes` list in
`biome.jsonc`, not the VCS ignore file (a minimal config checks the file;
`--vcs-enabled=false` with the repo config still skips it). A check that reports
`Checked 1 file` for a two-path invocation has silently skipped one of them.

**Rule:** Keep substantive logic in `packages/*/src/**` so it is linted and unit
tested, and leave `scripts/` entries as thin CLI wrappers. When a wrapper must be
linted, copy it under `src/` for the check and delete the copy. Read the
`Checked N files` count against the number of paths passed; do not treat
`No fixes applied` as proof. Do not widen `biome.jsonc` from the fork: it is
upstream's file and a merge-conflict magnet.

**Applies to:** any new TypeScript outside `apps/**` or `packages/*/src/**`,
and any lint claim in a handoff or decision record.
