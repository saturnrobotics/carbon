# Fork records policy

These rules apply to every task retained on this fork, including ordinary feature
work. User instructions take precedence. Within the repository, this policy's
artifact paths override inherited `.ai/` write paths. Continue reading upstream
`.ai/lessons.md` and relevant package instructions.

Upstream synchronization is a separate concern with its own tooling and
documentation under `docs/fork/` and `scripts/fork/`; this file does not describe it.

## Start from known source

- Give each independent task an isolated worktree based on an explicit reviewed
  revision. Before editing, inspect `git status --short`, `git rev-parse HEAD`, and
  `git worktree list`. Confirm any prerequisite branch-only file exists at that
  revision. Missing prerequisites are a base-selection problem, not permission to
  recreate the absent feature.
- Assign one coordinator as the Git writer per worktree. Helpers may edit
  exclusively assigned files; only that coordinator stages, commits, switches
  branches, or changes shared Git state. Never change another agent's environment,
  test credentials, lockfile, database, or running services.
- Preserve unrelated working changes. Do not use blanket restore/reset/clean,
  automatic stash/pop, `git add -A`, or force-add ignored files. Record exact
  revisions and verification results without copying private runtime values.

## Own records separately

Use the following mapping whenever an inherited skill requests an artifact. This
mapping also applies to `/feature`, `/fix`, `/plan`, `/execute`, `/conductor`,
`/test`, `/self-review`, and `/writing-skills`; their other procedures still apply.

| Inherited destination | Fork destination |
| --- | --- |
| `.ai/lessons.md` additions | `.fork/lessons/{date}-{slug}.md`, one lesson per file |
| `.ai/specs/` (including `implemented/`) | `.fork/specs/` with the same suffix |
| `.ai/plans/` (including `improve/`) | `.fork/plans/` with the same suffix |
| `.ai/research/` | `.fork/research/` |
| `.ai/playbooks/` | `.fork/playbooks/`, synthetic reusable procedures only |
| `.ai/runs/`, `.ai/scratch/`, screenshots, process state | `.fork/local/`, ignored |
| Durable decisions and concise verified outcomes | `.fork/decisions/{date}-{slug}.md` |

Read both upstream and fork specs/lessons before designing related work. Do not
rewrite upstream records simply to add a fork note. Historical migrated records
under `.fork/decisions/archive/` are preserved evidence; create no new execution
logs there. Add lessons using `Context → Problem → Rule → Applies to`. Keep public
records synthetic and concise. Actual deployment inputs still belong in
`contrib/deploying/gcp-tailscale/.local/` or the deployment secret store.

## Verification

Never claim work is complete without running the applicable checks for the touched
packages and reading their output. A successful installer, no conflict markers, a
build, or a mocked test alone does not establish behavioral correctness. Never
bypass hooks, remove a required check, weaken a fixture, or add skip flags to get a
change through; if a required check cannot run, keep the change unpromoted and
report the missing evidence.
