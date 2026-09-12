## Git calls from hooks must run from the repository root

**Context:** The pre-commit hook runs `pnpm db:check:backups -- --stage`, which regenerates `packages/jobs/manifests/schema.json` and `git add`s it, from a linked worktree whose path contains spaces.

**Problem:** Git exports `GIT_DIR` to hooks. `pnpm --filter` ran the script with `packages/jobs` as its cwd, and with `GIT_DIR` set but no `GIT_WORK_TREE`, git took that cwd as the work-tree root. `git add <absolute path>` then silently indexed the manifest as `manifests/schema.json` at the repository root: the commit gained a new file at the wrong path while the tracked manifest stayed unstaged, and the script still reported success.

**Rule:** A script that shells out to git from a package directory must pass `cwd: <repository root>` (or `git -C <root>`) on every call, and must never infer success from the exit code alone when staging — verify the staged path. Reproduce hook-only behavior with the hook's environment, not by rerunning the command by hand, which succeeds.

**Applies to:** `check-backups.ts --stage`, regenerate scripts, any hook step that stages generated files, especially in linked worktrees where `GIT_DIR` is absolute and the failure is silent rather than a "not a git repository" error.
