# Local deployment and fork maintenance

`saturn/main` is the shared integration and deployment branch. Keep `origin`
pointed at the public fork and `upstream` at `https://github.com/crbnos/carbon.git`.
Merge upstream in an isolated candidate, then fast-forward the shared branch to
that verified commit. The helpers never force-push, delete branches, or choose
conflict resolutions. Follow the [fork agent policy](../../../.fork/agent-policy.md)
for generated files and persistent agent records.

Keep custom deployment code and operator documentation under this directory.
Avoid changing upstream root files such as `README.md` when a local document or
wrapper can do the job. The existing root `Makefile` remains a small entry point
for `make deploy`. Put actual operator settings only in ignored `.local/` files.

## Start a feature

Start from your reviewed, current deployment branch. If collaborating with other
contributors, fetch `origin` and integrate their `saturn/main` changes first. A
fast-forward-only pull stops for explicit review if local and remote work diverge.

```bash
git switch saturn/main
git pull --ff-only origin saturn/main
bash contrib/deploying/gcp-tailscale/fork.sh feature feature/example
```

The helper requires a clean checkout of `saturn/main` and creates the named
branch at its exact commit. Implement the feature there, inspect the diff for
private details, run the checks required by the affected packages, and commit.
Use synthetic records and `example.com` in tracked examples.

## Verify and finish a feature

Keep the feature branch descended from the current `saturn/main`. If the shared
branch advances, merge it into the feature and verify the resulting revision.
Review committed source for private data, then publish the candidate and open a PR
targeting `saturn/main` when publication is authorized. The `Fork verification`
workflow checks the candidate SHA; its `fork-verified` job must succeed.

```bash
bash contrib/deploying/gcp-tailscale/fork.sh finish feature/example
```

`finish` (also named `promote`) checks candidate ancestry, runs Git-snapshot
preflight, queries GitHub for successful verification of that exact SHA and
branch, and fast-forwards `saturn/main`. It creates no extra merge commit that
would need fresh verification. Missing, pending, skipped, failed, or unrelated
verification blocks promotion. Candidate branches are retained.

## Ask the agent to update upstream

The coding agent owns the sync from discovery through verified promotion. Ask:

> Sync this fork with upstream. Resume any existing integration, preserve my
> working changes, resolve conflicts, regenerate outputs, run verification,
> publish the candidate for CI, and promote the verified commit to `saturn/main`.
> Do not deploy.

The agent finds the right worktree and baseline; you do not need to copy paths,
edit generated files, install individual tools, or relay each command. An upstream
sync request covers the publication and promotion needed to finish that request
unless you restrict its scope. Deployment requires a separate request. Credentials,
destructive actions, and bypassing protections are never implied.

The agent must:

1. Inspect the current checkout, `git worktree list`, merge state, and existing
   edits. Resume the existing sync candidate when present. Record the original
   checkout and previous reviewed full SHA in `.fork/plans/`, keeping local paths
   and runtime evidence in ignored `.fork/local/`.
2. Reconcile authored intent, including manifests and new migrations. Preserve
   unrelated original-checkout edits and upstream records. Bootstrap the pinned
   tools in the candidate and repair locally fixable integration failures.
3. Regenerate database outputs in infrastructure owned by `.fork/schema.py`, then
   dependent source outputs. Review changes, run the required checks, and commit
   with normal hooks.
4. Publish the candidate when covered by the request, watch its exact-SHA CI,
   diagnose failures, and repeat verification after fixes. Promote only after
   `fork-verified` succeeds. Report the resulting SHA and verification evidence.

Missing local packages or a stopped local Docker service are tasks for the agent
to resolve within the authorized environment. Do not end the task with a manual
checklist at the first recoverable failure. Preserve the candidate and ask only
for access or a decision the agent cannot obtain, such as unavailable credentials
or conflicting work that cannot safely be preserved. Required checks stay
unverified until they actually pass; deployment remains separate.

## Upstream sync command reference

These are the agent's operating steps and the fallback for a manual sync.

### 1. Discover or create the candidate

Start with read-only inspection from the current checkout:

```bash
git status --short
git rev-parse HEAD
git worktree list
```

If a sync already exists, locate its branch and folder in that list and inspect
its `git status` before changing anything. Continue there; rerunning `fork.sh sync`
for the same pair of commits reports the existing branch rather than resuming it.
Recover the original full reviewed SHA from the integration record. For an initial
merge still in progress with no candidate commit, `HEAD` remains that starting
SHA; confirm the merge state and ancestry. A later candidate commit is never its
own verification baseline.

For a new sync, from the clean original `saturn/main` checkout:

```bash
sync_original_checkout="$PWD"
sync_base_sha="$(git rev-parse HEAD)"
python3 .fork/verify.py preflight --revision HEAD
make sync
```

`make sync` invokes `bash contrib/deploying/gcp-tailscale/fork.sh sync`. It
creates the integration candidate; it does not launch a coding agent or promote
the candidate. The agent continues conflict resolution, regeneration, CI, and
verified promotion as described above.

The helper requires a clean `saturn/main`, runs preflight, and fetches
`upstream/main`. If there is nothing to merge, it creates nothing. Otherwise:

```text
Sync candidate: sync/upstream-<upstream12>-<stable12>
Sync worktree: /parent/carbon-worktrees/upstream-<upstream12>-<stable12>
```

The candidate is a **Git branch**; the worktree is a **folder containing another
checkout**, with its own files and index. New worktrees live in a persistent
sibling directory named `<repo-name>-worktrees`. The original checkout stays
unchanged during conflict resolution. Existing worktrees under `/private/var/`
or another temporary directory are valid and should be resumed.

The agent records the actual values and runs all candidate commands there:

```bash
sync_candidate_branch='sync/upstream-<upstream12>-<stable12>'
sync_worktree='/actual/path/from/git-worktree-list'
cd "$sync_worktree"
git branch --show-current
git status
git diff --name-only --diff-filter=U
```

The branch must match the recorded candidate. The final command lists unresolved
files. When resuming in another terminal, restore `sync_original_checkout` and
`sync_base_sha` from the recorded context before using later commands.

An agent may move an old temporary worktree when editors, agents, and commands
using it are quiescent. From outside that worktree, use `git worktree move` with
its actual path and a new, unused persistent destination. Update the recorded path
only after success. This preserves the index and in-progress merge; never use
`mv`, force the move, or abandon resolution work just to get a different folder.
If the original checkout is dirty, preserve its edits and continue existing
candidate work; do not stash, reset, or commit unrelated files to satisfy a helper.

### 2. Reconcile inputs and bootstrap tools

Inputs are authored application code, SQL migrations, dependency declarations,
generator scripts, documentation, and translations. Outputs are derived types,
manifests, catalogs, and compiled assets. Reconcile the combined source intent
before generating its outputs. Use the [artifact registry](../../../.fork/generated-artifacts.json).

| Conflict or affected file | Agent action |
| --- | --- |
| Source, config, new migrations | Inspect both changes and real callers; preserve intended behavior. Never rewrite previously applied migrations. |
| `.ai/` records | Preserve upstream and unfamiliar content; move identifiable fork additions to `.fork/`. |
| `pnpm-lock.yaml` | Resolve manifests, catalogs, overrides, and patches first; repair the existing lockfile with pinned pnpm. Review resolved-version changes. |
| Database types, Swagger, backup manifest | Regenerate all four together using `.fork/schema.py --regenerate`. |
| MCP digest / `tool-metadata.json` | Build `@carbon/documents`, run `generate:mcp`, review/stage the digest, and keep metadata ignored. |
| Workflow catalog | Run `generate:workflow-catalog` after the database Swagger schema is ready. |
| Agent knowledge files | Reconcile `docs/content/`, then run `generate:agent-kb`. |
| Translation `.po` files | Preserve authored translations and reconcile extracted messages using the locale workflow. |

Capture preflight evidence before installers or generators overwrite it. After
reconciling dependency declarations, repair the existing lockfile if needed:

```bash
corepack pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile
git diff -- pnpm-lock.yaml
```

Review resolved versions. Bootstrap the candidate without running postinstall
across unresolved generated files, then install the Supabase executable:

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm rebuild supabase
corepack pnpm exec supabase --version
```

The CLI version must match the reconciled `pnpm-workspace.yaml` catalog. Repair
missing tools locally; do not borrow another worktree's dependencies. Schema work
needs Python, PyYAML, and local Docker with Compose using a Unix-socket context:

```bash
python3 -c 'import yaml'
python3 - <<'PY'
import runpy
import subprocess
environment = runpy.run_path('.fork/schema.py')['clean_environment']()
for arguments in (
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    ['compose', 'version'],
    ['info'],
):
    subprocess.run(['docker', *arguments], env=environment, check=True)
PY
```

These commands must succeed and the endpoint must start with `unix://`. Install
missing Python packages in an ignored virtual environment, for example:

```bash
python3 -m venv .fork/local/schema-tools
.fork/local/schema-tools/bin/python -m pip install PyYAML==6.0.2
. .fork/local/schema-tools/bin/activate
```

Start or provision an owned local Docker runtime using the available environment;
leave other tasks' services, credentials, and databases alone. If access is truly
unavailable, report the specific prerequisite without its secret value while
continuing independent resolutions. Never substitute an existing database.
The diagnostics use the verifier's sanitized environment: `DOCKER_HOST` and
`DOCKER_CONTEXT` overrides are deliberately not inherited. Resolve context setup
within the task's environment rather than switching another task's runtime.

### 3. Regenerate and review outputs

With reconciled migrations and generator inputs, run in the candidate:

```bash
python3 .fork/schema.py --base "$sync_base_sha" --regenerate
```

Repair mode accepts the starting reviewed SHA equal to `HEAD` during an unfinished
merge and reads the reconciled worktree dependency catalog. It preserves historical
base migrations and allocates its own disposable database. Review the four
proposed outputs under the printed `.fork/local/schema-runs/<nonce>/fresh/` and
copy them to the same relative repository paths:

```text
packages/database/src/types.ts
packages/database/supabase/functions/lib/types.ts
packages/database/src/swagger-docs-schema.ts
packages/jobs/manifests/schema.json
```

`GENERATED/UNVERIFIED` means proposed output, not verification. Do not hand-edit
types, choose one entire side, commit placeholders, or run `generate:types` against
an existing dev/production database. Diagnose and fix reproducible generator
failures with regression evidence instead of asking the user to finish the merge.

Once schema outputs are ready, rebuild affected source outputs:

```bash
corepack pnpm --filter @carbon/documents build
corepack pnpm run generate:mcp
corepack pnpm run generate:workflow-catalog
```

Review and stage specific paths with `git add -- <path>`, quoting shell characters
such as `$` in route filenames. `git diff --name-only --diff-filter=U` must print
nothing. Do not use `git add -A`, blanket `ours`/`theirs`, or lockfile deletion.

### 4. Verify, commit, publish, and promote

With all reviewed candidate inputs and outputs staged and working files matching
the index, run:

```bash
python3 .fork/verify.py preflight --revision index --base "$sync_base_sha"
corepack pnpm install --frozen-lockfile
python3 .fork/verify.py generated --revision index
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .fork/tests -v
```

Every command must pass; tests must report `OK`. If generation changes intended
output, review and stage that specific path, then repeat both comparisons. Run
applicable safe lint autofixes, strict lint, scoped tests/typechecks, and behavior
checks. The default local generation check covers only `source`, not full CI.
For pre-commit strict Biome checks, pass the reviewed file paths explicitly to
`python3 .fork/ci.py biome <paths>`. The `lint --base` subcommand compares committed
revisions; run it after committing, not as proof of an uncommitted merge.

Inspect `git diff --cached` for correctness and privacy, then commit with normal
hooks and a non-interactive message. `git commit -m '<reviewed merge message>'`
completes a pending merge. If the helper already committed the merge, commit only
subsequent reviewed changes. Verify the resulting commit; for schema changes:

```bash
python3 .fork/schema.py --base "$sync_base_sha"
```

Strict verification requires a distinct ancestor baseline and proves the committed
candidate through fresh installation and upgrade in owned disposable infrastructure.
Publish and promote when covered by the user's sync request:

```bash
git push -u origin "$sync_candidate_branch"
git rev-parse HEAD
```

Pushes to `sync/**` run **Fork verification**. The agent monitors the exact branch
and SHA until **`fork-verified`** succeeds, fixes failures within scope, and obtains
new evidence after every new commit. Missing, pending, skipped, canceled, or failed
results block promotion; no bypass is allowed.

After success, from the original clean checkout:

```bash
cd "$sync_original_checkout"
bash contrib/deploying/gcp-tailscale/fork.sh promote "$sync_candidate_branch"
git status
```

Promotion fast-forwards local `saturn/main`; it does not push the shared branch or
deploy. If `saturn/main` advanced, merge it into the candidate, review and verify
the resulting SHA, then retry. Preserve unrelated edits in the original checkout;
if they prevent safe promotion, report that exact remaining constraint rather
than discarding or committing them. `make deploy` publishes the shared branch
normally when deployment is separately requested.

Keep the candidate worktree and branch by default. Abort or remove them only when
requested and after preserving needed resolution work and ignored artifacts.
Never force removal of a dirty worktree. The older
`bash scripts/sync-upstream.sh` entry point runs the same helper.

## Deploy from your laptop

Once the [one-time setup](README.md) is complete, review the merged changes and
run the required checks. Commit all intended source changes, then:

```bash
git switch saturn/main
make deploy
```

`make deploy` requires a clean checkout of `saturn/main` and successful
`Fork verification` for its exact revision before publication or cloud mutations.
A successful run for that same SHA on the reviewed candidate branch is accepted,
so promotion does not require publishing the shared branch before verification.
The verifier uses GitHub's public API; unavailable or incomplete evidence blocks
deployment, with no bypass flag. A no-op release still returns without publication,
verification-network calls, or cloud mutations.

For a changed release, the command fetches upstream
and stops with a `fork.sh sync` instruction if new upstream changes need merging.
It publishes the exact deployment commit to `origin/saturn/main` using an ordinary
push and checks that its source can be downloaded publicly. You do not need to
push in a separate step. Review committed changes for private data before running
the command: deployment publishes those commits.

`make deploy` generates private release inputs and automatically chooses the
routine or coordinated snapshot/migration rollout, including initial release
tracking setup. No hand-written manifest or separate baseline command is needed.
`make deploy-check` and `make deploy-plan` are optional diagnostics. See
[the deployment guide](README.md#automatic-release-preparation) for rollout details.

The command archives the committed source on your laptop and uploads it to GCP
for the build and deployment. Private `.local/` configuration is transferred
separately. Uncommitted files are never included in the source archive. The
application's source link identifies the exact deployed revision.

If publishing is rejected because someone else updated `origin/saturn/main`,
fetch and review their commits, merge them into a candidate branch, repeat
verification, and promote that candidate before retrying. Never
force-push away another contributor's work.

Review migrations before deployment. Keep a private record of the deployed
revision and backup; application rollback may require a compatible database
restore. The [public-fork policy](../../../docs/public-fork.md) also applies to
commit messages, source archives, build inputs, and other published artifacts.
