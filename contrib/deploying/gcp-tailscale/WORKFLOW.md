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

## Update upstream in a separate worktree

```bash
git switch saturn/main
bash contrib/deploying/gcp-tailscale/fork.sh sync
```

`sync` requires a clean `saturn/main`, runs preflight, and fetches `upstream/main`.
If new upstream commits exist, it creates a `sync/upstream-*` branch in a separate
temporary worktree and merges there. It prints both the branch and worktree path.
The original checkout, index, and `saturn/main` commit stay unchanged on success
and on conflicts. The worktree is retained for review; rerunning the same sync
reports the existing candidate instead of creating another one.

In that worktree, resolve authored inputs first and regenerate outputs using the
[artifact policy](../../../.fork/README.md). Review and commit all intended
generated changes. After authorized candidate publication, pushes to `sync/**`
run `Fork verification`. Once `fork-verified` succeeds, return to the original
clean checkout and run `fork.sh promote` with the printed candidate branch.

To update upstream between features, switch to `saturn/main` and run `sync`.
The older `bash scripts/sync-upstream.sh` entry point runs the same helper.
Run this regularly and before each deployment; there is no unattended merge job.

If Git reports conflicts, inspect `git status` in the printed candidate worktree.
Stage only reviewed files and complete that merge with `git commit`. To abandon
the merge, run `git merge --abort` in that worktree. Correct failed checks before
promotion; keep normal hooks enabled. A hook or a successful merge alone is not
the required workflow evidence.

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
