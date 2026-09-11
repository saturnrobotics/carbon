# Keeping this fork current with upstream

`saturnrobotics/carbon` is a long-lived, self-hosted fork of
[`crbnos/carbon`](https://github.com/crbnos/carbon). This document is the **only**
description of how upstream is integrated. The previous process (a Codex sync agent,
`fork.sh`, the `.fork/` verification suite, the `fork-check` workflow and the
`fork-maintenance` skill) is retired and was removed from the repository; nothing
in this repository refers to it any more.

Everything below lives in `scripts/fork/` (scripts), `.github/workflows/` (CI) and
this directory (docs). The fork's integration and deployment branch is
`saturn/main`; the scripts call it the *trunk* and read it from `FORK_TRUNK`.

## Merge, never rebase

Upstream is integrated by **merging** `upstream/main` into `saturn/main`. The fork's
history is never rewritten, squashed or force-pushed. Rebasing a deployed branch
re-creates every fork commit on top of upstream, which re-resolves every past
conflict, invalidates every SHA that was ever deployed or reviewed, and breaks the
many local worktrees and branches that descend from it. A merge resolves each
conflict exactly once, keeps `git rerere` useful, and leaves a first-parent history
that reads as "fork work, with upstream folded in on these dates".

## One-time setup per clone

```bash
bash scripts/fork/setup-git.sh
```

Git configuration is not versioned, so this script is the single source of truth
for it. It is idempotent and also runs from `pnpm install` (`prepare`), so an
ordinary install already does this. It:

- adds the `upstream` remote (or repoints a stale one at `crbnos/carbon`),
- enables `rerere` with `autoupdate` and sets `merge.conflictstyle` to `zdiff3`,
- removes merge-driver definitions left by the retired tooling (none were found
  at inventory time; the list in the script is where a name would go),
- registers the `regen` merge driver (`cp %B %A`).

**Existing clones:** run it once by hand. It cleans up legacy git config the same
way it sets up a fresh clone, so there is nothing else to undo. The retired sync
agent also kept state under `.git/carbon-sync-agent/`; that directory is inert and
can be deleted.

## Generated files never conflict

The files listed with `merge=regen` in [`.gitattributes`](../../.gitattributes)
(database types, the swagger schema, the backup manifest, the MCP tool digest, the
workflow catalog, the agent knowledge base, `pnpm-lock.yaml`, `Cargo.lock`) are
never hand-resolved. On merge the `regen` driver silently takes upstream's copy;
`scripts/fork/regenerate.sh` then rebuilds all of them from the merged sources:

```bash
bash scripts/fork/regenerate.sh            # apply pending migrations to your local DB, regenerate, stage
bash scripts/fork/regenerate.sh --fresh    # CI / disposable stacks: wipe volumes, apply from scratch
```

It uses the repository's own runner (`crbn`, in `packages/dev`) rather than
`supabase start`: this repo's local stack is a Docker compose project and its
migrations are applied with `supabase migration up --include-all`. Docker must be
running. The order is dependencies → migrations → database-derived files
(types, swagger, backup manifest) → source-derived files (MCP digest, workflow
catalog, agent kb) → `Cargo.lock`.

The invariant that makes this safe is the **`generated-files-drift`** workflow: on
every pull request and every push to `saturn/main` or `sync/**` it runs
`regenerate.sh --fresh` and fails if `git diff` is not empty. A stale generated
file cannot reach the trunk.

Lingui `.po` catalogs are *not* regen files: they hold authored translations.
Upstream's own mechanism handles them (`merge=union` plus the post-merge hook that
re-extracts and normalises). If a merge touches them, run
`pnpm lingui:extract && pnpm lingui:clean` before committing.

## The sync flow

### Scheduled (default)

The `upstream-sync` workflow runs every second Monday at 06:00 UTC (cron every
Monday, even ISO weeks pass the in-job gate). It fetches upstream, creates
`sync/upstream-<date>`, merges `upstream/main` with the regen driver configured,
and:

- **clean merge** → runs `regenerate.sh` and `check-migrations.sh`, commits,
  pushes, runs lint/typegen/typecheck/test/build in-job, and opens a PR titled
  `Sync upstream <sha> (<date>)` labelled `upstream-sync`. The body lists the
  upstream commit range and log, the migration-ordering warnings, the regenerated
  files and the check results.
- **conflicts** → commits the conflicted tree as
  `WIP: unresolved upstream conflicts (do not merge)` (markers included, on
  purpose), pushes, and opens a **draft** PR labelled `upstream-sync` and
  `needs-conflict-resolution` with a checklist of the conflicted files. CI failing
  on that draft is the intended signal.

It never pushes to `saturn/main`. Dispatch it manually (`workflow_dispatch`) for an
out-of-cycle sync; the `upstream_ref` input lets you target an upstream tag.

Because the default `GITHUB_TOKEN` cannot trigger other workflows, the PR it opens
gets its checks from the in-job run rather than from `check.yml` and
`generated-files-drift`. Add a repository secret `FORK_SYNC_TOKEN` (fine-grained
PAT, contents + pull-requests write) and the PR runs the normal CI too.

### Locally

```bash
git switch saturn/main && git pull --ff-only
bash scripts/fork/sync-upstream.sh --dry-run   # what would happen: commits pending, conflicts, regen files
bash scripts/fork/sync-upstream.sh             # do it
```

The script refuses a dirty tree or any branch other than the trunk, exits 0 when
the trunk already contains `upstream/main`, creates `sync/upstream-YYYY-MM-DD`
(`-2`, `-3`, … if taken) and merges with `--no-ff --no-commit`. With no conflicts it
regenerates, runs the migration guard, commits as
`Merge upstream/main (<sha>) into saturn/main` and prints the push/PR commands.

### The conflict path

When real (non-generated) files conflict, `sync-upstream.sh` prints them with their
fork-side drift and exits 2, leaving the merge in progress. Resolve them with these
rules — the same ones the assisted resolver follows
([`RESOLVE_PROMPT.md`](RESOLVE_PROMPT.md)):

1. `upstream/main` is the intended direction for shared code.
2. The fork's customizations ([`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md)) are the
   intended direction for fork-owned code.
3. Keep both behaviours when they are orthogonal; stop and ask when they are not.
4. Never touch a `merge=regen` file by hand.

Then:

```bash
git add <resolved files>
bash scripts/fork/finish-sync.sh
```

`finish-sync.sh` verifies that no conflict markers remain, regenerates, runs the
migration guard, and commits with a `Conflicts:` block naming the files so
`drift.sh` can report them later. On a scheduled draft PR, apply the
`needs-conflict-resolution` label (or comment `/resolve`) to run the assisted
resolver, or check the branch out and follow the same steps.

### Migration ordering

Both sides add timestamped migrations. `scripts/fork/check-migrations.sh [base]`
lists the migrations a merge introduces and warns about any timestamped *earlier*
than the newest migration already on the trunk. Supabase applies by version, so
they still run, but their author never saw the schema state a later fork
migration may have changed — read them. Duplicate version numbers fail the check.

## Cadence

- **Biweekly** by schedule, or on an upstream release tag via `workflow_dispatch`.
- **Out of cycle** for security fixes or a feature we want: dispatch the workflow
  or run `sync-upstream.sh` locally.
- Every sync lands through a reviewed PR; there is no unattended path to the trunk.

## Deploy rule

Deploys come from `saturn/main` only (`make deploy` enforces the branch and a
clean tree). `sync/**` branches are never deployed. `make deploy` additionally
requires a successful `generated-files-drift` run for the exact revision it
deploys (`contrib/deploying/gcp-tailscale/verify_source.py`). Sync cadence and
deploy cadence are independent: the deploy script no longer checks whether
upstream has been merged.

## GitHub settings this process needs

These are repository settings, not files, so they are listed here for the
maintainer:

- **Branch protection on `saturn/main`** must require the `generated-files-drift`
  check (it currently requires the retired `fork-verified` context, which nothing
  produces any more — until it is changed, nothing can be merged into the trunk).
  Requiring the `check.yml` jobs as well is recommended; they now run on
  `saturn/main` too.
- **Default branch.** GitHub only runs `schedule` triggers from the default
  branch. The fork's default branch is `main` (a stale upstream mirror). Either
  make `saturn/main` the default branch (recommended) or the scheduled sync will
  never fire.
- **Labels** `upstream-sync` and `needs-conflict-resolution` are created on demand
  by the workflow.
- **Secrets** (optional): `FORK_SYNC_TOKEN` (see above), `ANTHROPIC_API_KEY` for
  the assisted resolver.

## Measuring drift

```bash
bash scripts/fork/drift.sh          # trunk vs upstream/main
bash scripts/fork/drift.sh HEAD     # this branch
```

Snapshots live in [`DRIFT.md`](DRIFT.md). The inventory of what the fork changes,
and what could be pushed upstream, is [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md).
Anything generic should be contributed upstream with
`scripts/fork/upstream-pr.sh <branch> <commit>...`, which cherry-picks fork commits
onto `upstream/main` so the contribution carries none of the fork's merge history.

## Fork-owned checks without a CI runner

The retired `fork-check` workflow also ran a handful of checks for fork-owned code
that have no other runner today. Until they get a fork-owned workflow, run them
locally when you touch the relevant area:

```bash
pnpm exec tsx --test scripts/lib/generate-db-types.test.ts scripts/lib/swagger-schema.test.ts scripts/lib/local-script-config.test.ts
pnpm exec tsx --test .fork/tests/dispatcher.test.ts .fork/tests/locales.test.ts
pnpm exec tsx .fork/check-locales.ts && pnpm exec linguito check
python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p 'test_*.py'   # needs PyYAML 6.0.2
python3 contrib/deploying/knowledge/verify-build-context.py
```
