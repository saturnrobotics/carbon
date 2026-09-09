---
name: fork-maintenance
description: Maintains the public fork through verified integration, source-first conflict resolution, and persistent agent safeguards. Use when merging upstream, resolving generated or lockfile conflicts, auditing integration drift, or changing fork maintenance rules. For ordinary application changes, use the relevant feature or fix skill while following .fork/agent-policy.md.
---

# fork-maintenance — integrate and verify the public fork

Input: a reviewed fork revision and the upstream or feature revision to integrate.
Output: a reviewed candidate with verification evidence and, when covered by the
user's sync request, publication for exact-SHA CI and verified promotion. The agent
owns that full lifecycle. Honor narrower requests; deployment remains separate.
This skill grants no credentials, destructive-action permission, or check bypass.

**Announce at start:** "Using the fork-maintenance skill — verify the fork integration."

## Step 1: Load the rules and identify the source

Read `.fork/agent-policy.md`, `.fork/generated-artifacts.json`, and
`contrib/deploying/gcp-tailscale/WORKFLOW.md`. Read the relevant upstream and fork
lessons/specs. All new fork artifacts use the policy's `.fork/` paths, even when a
sibling skill requests `.ai/`. Logs and process state go in ignored `.fork/local/`.

```bash
git status --short
git rev-parse HEAD
git worktree list
python3 .fork/verify.py preflight --revision HEAD
```

Expected: the revision is the intended base and preflight exits 0. Inspect and
preserve any working changes; do not stash, reset, clean, or stage them wholesale.
For a known corrupt generated baseline, preserve the failed preflight result and
original Git SHA in ignored `.fork/local/`. Inspect the source manifests and
lockfile, then bootstrap dependencies in the isolated repair candidate with
`corepack pnpm install --frozen-lockfile --ignore-scripts`. This explicitly prevents
postinstall from erasing the evidence. Build only generator prerequisites (for MCP:
`corepack pnpm --filter @carbon/documents build`), reconcile source inputs, and run
the registry's generator. Review and explicitly stage the corrected outputs and
tracking changes, then require index preflight to pass before normal installation.
A successful repair does not turn the original failed preflight into a pass.

Record the previous reviewed integration/deployed full SHA in the task plan under
`.fork/plans/`. Use it as `--base` on later preflights. If it is unknown, STOP
promotion and identify it from the recorded release or reviewed branch; never
substitute an arbitrary ancestor to make migration checks pass.

## Step 2: Integrate with preserved ancestry

First use `git worktree list` and candidate `git status` to resume any existing
integration without losing edits. Record its branch and previous reviewed full SHA
in the plan; keep worktree/original-checkout paths in ignored `.fork/local/`.
For a new integration, use
`bash contrib/deploying/gcp-tailscale/fork.sh sync` following `WORKFLOW.md` from a
clean `saturn/main`. It creates a persistent sibling worktree under
`<repo-name>-worktrees/`; legacy temporary worktrees remain valid. The agent may
move a quiescent legacy worktree with Git to an unused persistent destination.
Only one coordinator may mutate Git state in a worktree. The stable integration branch is `saturn/main`.
Never rebase that shared branch, squash upstream history, or force-push.

If conflicts occur, inspect `git status --short` and apply this table. Preserve
authored changes on both sides when they remain applicable.

| File category | Action |
| --- | --- |
| `.ai/` authored upstream records | Reconcile upstream content; move identifiable fork-only authored records into `.fork/` with references preserved. Never discard unknown content. |
| Source, config, migrations | Reconcile intent and real callers first. Existing applied migrations remain immutable. |
| Generated output | Consult the registry. Regenerate tracked contracts from reconciled controlled inputs; keep disposable output untracked. |
| `pnpm-lock.yaml` | Reconcile manifests/catalogs/overrides/patches, then reconcile the existing lockfile using the `packageManager`-pinned pnpm; review version changes and run a frozen install. |
| Authored translation `.po` files | Preserve translated text while reconciling extracted messages; normalize with the locale workflow. |

Do not use blanket `ours`/`theirs`, union merge, generated placeholders, lockfile
deletion, type suppressions, or "it will fix itself on install." Reused conflict
resolutions need the same checks as new ones. Missing configuration is a failed
prerequisite; do not guess values or borrow another task's database/credentials.

After reviewing the reconciled dependency declarations, run
`corepack pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile` to
repair the existing lockfile, inspect the resolved-version changes, then require
the frozen install below. For generated database conflicts, run
`python3 .fork/schema.py --base <reviewed-full-SHA> --regenerate` with the pinned
installed toolchain and local Unix-socket Docker. Before repair, bootstrap with
`corepack pnpm install --frozen-lockfile --ignore-scripts`, run
`corepack pnpm rebuild supabase`, then `corepack pnpm exec supabase --version`;
require the reconciled worktree catalog version. Follow `WORKFLOW.md` to install
missing Python/PyYAML and provision owned Docker/Compose. Repair accepts the
starting reviewed SHA equal to `HEAD` during a pending merge; strict verification
after committing still requires a distinct ancestor baseline. Follow the
four-output review and copy procedure in `.fork/agent-policy.md`. This allocates new disposable
infrastructure and reports `GENERATED/UNVERIFIED`; it never makes an existing
database eligible for testing or approves a release. Commit the reviewed candidate
and run the default strict schema check afterward.

## Step 3: Prove the candidate before promotion

Before normal installation or lifecycle scripts overwrite evidence, explicitly stage reviewed resolutions and
run `python3 .fork/verify.py preflight --revision index --base <reviewed-full-SHA>`.
Replace `<reviewed-full-SHA>` with the recorded value; expected exit status is 0.
Stage every candidate source, manifest, config, and generator change before index
generation, and keep those working files equal to the index. Preserve unrelated
work in its original worktree; use an isolated candidate instead of staging it.
Then use the pnpm version pinned in `package.json#packageManager`:

```bash
corepack pnpm install --frozen-lockfile
python3 .fork/verify.py generated --revision index
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .fork/tests -v
```

Expected: all commands exit 0; the tests conclude `OK`. Do not count a skipped
database check as a pass. Schema generation and upgrade comparisons use
`.fork/schema.py` and its newly allocated disposable infrastructure, locally or in
CI, never an existing developer or production database. Run
applicable safe lint autofixes, strict lint, scoped package tests/typecheck, and the
behavior/build checks required by the actual diff. Inspect generated and dependency
changes against their original Git inputs, including changes made by postinstall.
An intended input change may produce a generation-drift failure on the first run.
Review those outputs, stage only the accepted generated paths, and repeat both
index preflight and `generated --revision index`. Do not count the failing first
comparison as success or compare only two freshly regenerated worktree copies.

Complete the merge only after reviewing the final diff for correctness and public
privacy. Stage explicit paths, keep normal hooks enabled, and recheck the committed
SHA. Promotion/deployment requires `fork-verified` from
`.github/workflows/fork-check.yml` for that exact SHA; a missing, pending, skipped,
failed, or canceled job blocks promotion. Follow `WORKFLOW.md` for that final step.
The agent publishes the candidate for CI and promotes the verified SHA when
covered by the user's sync request. Monitor pending CI, diagnose failures, fix
within scope, and obtain new exact-SHA evidence before retrying promotion. Do not
stop at locally fixable missing tools or generator failures: repair them in the
isolated environment, preserving failures as regression evidence. Ask only for
unavailable access or a decision that cannot safely be inferred. Keep original
edits intact and report any actual remaining blocker; never turn it into a pass.
No local test result grants a remote-check bypass.
The CI source job verifies `source`, `knowledge`, `build`, and `routes` artifact
groups; the default local generation command checks only `source`. CI selects schema and
behavior suites from the explicit diff, and its daily audit runs every suite.
For a manual audit, dispatch Fork verification with the actual previous reviewed
full SHA in `base`. Missing or non-ancestor baselines must fail; do not use the
candidate SHA as its own baseline.

## Step 4: Verify rule changes survive the next integration

When changing this skill or its policy, run:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .fork/tests -p test_policy.py -v
bash .ai/scripts/install-skills.sh --skills-only
bash .ai/scripts/install-skills.sh --list
```

Expected: tests report `OK`, installation ends `Done.`, and the list includes
`fork-maintenance`. Never hand-edit generated `.codex/` copies. Ask a fresh agent
with only the entry points and these rules to resolve a synthetic generated-file,
lockfile, missing-database, and `.ai/lessons.md` scenario without modifying a real
repository. Repair any ambiguity revealed by its answer, then repeat the checks.

## Output

Report candidate SHA and base SHA; source/conflict decisions; exact checks and
results; generated changes; publication/promotion status; and any failed or
unavailable required verification with the specific external prerequisite.
Keep private runtime details out of tracked records and user-visible logs.

## Done when

- [ ] Inputs and authored records are preserved and conflict resolutions reviewed.
- [ ] Preflight and generation comparisons pass against the intended Git baseline.
- [ ] Applicable lint, tests, types, and behavior checks have actual evidence.
- [ ] The exact promoted SHA has successful required CI; otherwise report the
  candidate as unpromoted with the missing evidence.
- [ ] Policy changes pass installer tests and a fresh agent cold-read.
