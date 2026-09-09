# Fork agent policy

These rules apply to every task retained on this fork, including ordinary feature
work. User instructions take precedence. Within the repository, this policy's
artifact paths and verification requirements override inherited `.ai/` write paths,
generated-file placeholders, and advice to accept unavailable checks as success.
Continue reading upstream `.ai/lessons.md` and relevant package instructions.

## Start from known source

- Keep `saturn/main` as the stable integration branch. Merge upstream ancestry
  through a separate integration branch and verification; never rebase the shared
  fork branch, squash an upstream update, or force-push away published work.
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

## Own the integration lifecycle

For an upstream sync request, the agent discovers or resumes the existing candidate,
records the previous reviewed full SHA, resolves authored intent, bootstraps pinned
isolated tools, regenerates outputs, verifies, and commits with normal hooks.
Publication for exact-SHA CI and verified promotion are covered when they are part
of the user's requested sync; honor any narrower scope without asking for the same
authorization again. Deployment remains a separate action. This policy grants no
credentials, destructive-action permission, or protection bypass.

Follow `contrib/deploying/gcp-tailscale/WORKFLOW.md`. Find existing candidates with
`git worktree list`; preserve their merge state and all unrelated original-checkout
edits. New sync worktrees use the persistent sibling `<repo-name>-worktrees/`.
Move a legacy temporary worktree only with Git, to an unused destination, after
its users and processes are quiescent. One coordinator owns Git mutations.

Resolve locally fixable failures: install missing pinned tools in the candidate,
start or provision owned disposable infrastructure, and repair integration defects
with regression evidence. Continue through CI failures to verified promotion within
the authorized scope. Do not hand the user a checklist at the first missing package
or stopped service. Ask only for unavailable access or an unresolved decision;
never take over another task's services, credentials, or database. Preserve the
candidate and report missing evidence when a real external blocker remains.

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

## Resolve inputs before outputs

Consult [generated-artifacts.json](generated-artifacts.json) before resolving a
generated file or adding a generator. Record new output ownership, inputs,
generator, tracking policy, and verification there in the same change.

| Conflict or failure | Required action |
| --- | --- |
| Authored source, config, migrations, or translations | Reconcile intent and preserve both applicable changes; inspect real callers and the latest migration definitions. |
| Tracked generated contract | Reconcile its source inputs, regenerate with pinned tools from controlled inputs, then compare to the Git baseline and review semantic changes. |
| Disposable generated output | Preserve the declared untracked policy; regenerate locally. Do not restore it to tracking as a conflict shortcut. |
| `pnpm-lock.yaml` | Resolve manifests, workspace catalogs, overrides, and patches first; keep the existing lockfile; reconcile using the version in `package.json#packageManager`; review resolved-version changes; finish with `corepack pnpm install --frozen-lockfile`. |
| Database-derived output | Use `.fork/schema.py` to allocate its own disposable infrastructure, locally or in CI. Use its `--regenerate` repair mode for conflicted output; never supply an existing developer or production database. |
| Missing config or infrastructure | Identify the documented schema/default and validate it before constructing clients. Report the exact missing prerequisite without its secret value. Required verification remains failed or unverified. |

Never apply blanket `ours`/`theirs`, union merge, or an arbitrary generated-file
placeholder. Do not delete the lockfile to resolve conflicts, hand-edit generated
types, suppress a missing generated field, or modify historical migrations to make
fresh installation pass. A reused `rerere` resolution still requires review and
tests. New generators must preserve last-good outputs on failure, use stable
ordering, and include transitive inputs in any cache key; disable caching until
that coverage is demonstrated.

After reconciling dependency declarations, repair the existing lockfile with:

```bash
corepack pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile
```

Inspect all resulting dependency changes, then require the normal frozen install.
This command preserves the existing lockfile as solver input; deleting it or
ignoring its resulting version changes remains prohibited.

To repair generated database conflicts, use the pinned installed toolchain and a
local Unix-socket Docker service, then run
`python3 .fork/schema.py --base <previous-reviewed-full-SHA> --regenerate`.
This mode reads reconciled worktree migrations and generator inputs, preserves
historical base migrations, and creates its own disposable project. Repair accepts
the reviewed baseline equal to `HEAD` during an unfinished merge and reads the
reconciled worktree Supabase catalog pin; strict verification still requires a
distinct ancestor baseline and committed inputs. It writes four
proposed outputs below the printed `.fork/local/schema-runs/<nonce>/fresh/`:
`packages/database/src/types.ts`,
`packages/database/supabase/functions/lib/types.ts`,
`packages/database/src/swagger-docs-schema.ts`, and
`packages/jobs/manifests/schema.json`. Review and copy those four outputs to the
same relative repository paths, then run applicable formatting/checks and
explicitly stage the reconciled candidate. `GENERATED/UNVERIFIED` is a repair
result, not approval. After committing, require
`python3 .fork/schema.py --base <previous-reviewed-full-SHA>` and full CI for that
SHA. Bootstrap unresolved candidates with
`corepack pnpm install --frozen-lockfile --ignore-scripts`, then
`corepack pnpm rebuild supabase` and `corepack pnpm exec supabase --version`;
require the reconciled catalog version. Resolve missing Python/PyYAML and local
Unix-socket Docker/Compose prerequisites in the owned environment following
`WORKFLOW.md`. If access remains unavailable, keep the candidate unverified;
never substitute an existing database.

## Verification is a promotion requirement

Use `corepack pnpm` so the checked-in `packageManager` pin is honored even when
the shell has another pnpm version. Before installation or generators overwrite evidence, run:

```bash
python3 .fork/verify.py preflight --revision HEAD
```

For integration work, supply `--base` with the full SHA of the previous reviewed
integration/deployed revision. Validate the prospective index before committing
using `python3 .fork/verify.py preflight --revision index` (and that same `--base`
for integration). A worktree preflight is useful while editing but does not prove
the index or a commit. Run the pinned frozen install and relevant checks, then:

```bash
python3 .fork/verify.py generated
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .fork/tests -v
```

For a reviewed staged candidate before committing, use `generated --revision
index`; the default compares to committed `HEAD`. If intentional regeneration
differs from that snapshot, review and explicitly stage the output, then repeat
the comparison against the accepted index. Never replace the original baseline
with unreviewed generated output simply to turn the comparison green.
All candidate source, manifest, config, and generator changes must be staged, and
their working files must match the index. Keep unrelated changes in their original
worktree and perform verification in an isolated candidate; do not stage unrelated
work to satisfy this prerequisite.

Run applicable safe lint autofixes and strict lint, then scoped tests/typecheck and
required build/runtime checks. Verify generated changes against the captured Git
snapshot, not a postinstall-modified file. A successful installer, no conflict
markers, a build, or a mocked test alone does not establish behavioral correctness.
`.fork/ci.py lint --base <SHA>` checks changes committed at `HEAD`; it does not
validate an uncommitted merge index. Before committing, pass the actual reviewed
paths to `.fork/ci.py biome` (and Ruff for Python), then run the committed lint
command after committing. An empty committed diff is not evidence for staged work.
Review the actual diff and explicitly stage only intended public paths. After a
commit or merge changes the SHA, obtain verification for the resulting SHA.

`.github/workflows/fork-check.yml` reports the required `fork-verified` result.
Its always-required source job verifies the `source`, `knowledge`, `build`, and
`routes` artifact groups. Schema artifacts run in the separately required disposable schema job
when their inputs change; the daily audit requests every suite. The default local
`generated` command checks only the registry's `source` group and is not full CI.
Required jobs must pass for the exact revision being promoted or deployed. A
missing, pending, skipped, canceled, or failed check is not approval. Run schema
rebuild/upgrade verification only in infrastructure allocated as disposable by
`.fork/schema.py`, locally or through CI; never reset an existing database to
satisfy a check.

Never bypass hooks, remove a required check, weaken a fixture, add skip flags, or
use administrator/agent credentials to bypass remote branch protection. If a
required check cannot run, keep the change unpromoted and report the missing
evidence. Fix unrelated failures separately when authorized; do not label them
passing. Preserve a reproduced failure as a regression test before fixing it.

## Keep the safeguards working

When upstream changes generators, install scripts, lockfile format, migrations,
agent entry points, or CI, review the registry and enforcement together. Run the
negative fixtures as well as real generation. Changes to a policy or skill need a
fresh agent cold-read using a synthetic conflict scenario, plus the installer
tests. Check that the integration branch still requires `fork-verified` and that
deployment verifies the exact SHA; local Markdown cannot enforce remote settings.
Record limitations plainly. Never promise that passing structural checks rules
out all application bugs.

Generation checks protect registered source and common/declared private local
configuration inputs, including registry `protected_local` paths. They are not a
sandbox for arbitrary generator code or its external side effects. Always use an
isolated candidate, keep private runtime access out of verification, and declare
new local config inputs before introducing a generator that reads them.

CI records the baseline explicitly: PRs use their base SHA, integration pushes use
the previous pushed SHA, and sync branches use `origin/saturn/main`. Each must be
an available strict ancestor of the tested head. Manual workflow dispatch requires
the previous reviewed full SHA as its `base` input and always runs every suite.
The daily dispatcher, `.github/workflows/fork-audit-schedule.yml`, requests a manual
audit on `saturn/main` with its first parent as the upgrade baseline. The attesting
workflow itself has no schedule trigger: its event SHA must match its checked-out
candidate. The dispatcher must also exist on the repository's default branch for
GitHub to activate its schedule.
That daily comparison covers the most recent integration transition; use manual
dispatch with the actual earlier deployed SHA when auditing a longer upgrade.
Missing baselines fail; no gate substitutes `HEAD` to obtain an empty diff.
