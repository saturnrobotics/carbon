# Local deployment and fork maintenance

`saturn/main` is the shared integration and deployment branch. Keep `origin`
pointed at the public fork and `upstream` at `https://github.com/crbnos/carbon.git`.
Use merges for this shared branch so collaborators retain the same history. The
helpers never force-push, delete branches, or choose conflict resolutions.

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

## Finish a feature and update upstream

With the feature committed and verified:

```bash
bash contrib/deploying/gcp-tailscale/fork.sh finish feature/example
bash contrib/deploying/gcp-tailscale/fork.sh sync
```

`finish` switches to `saturn/main` and merges the local feature branch. `sync`
requires `saturn/main`, fetches the latest `upstream/main`, and merges it. Both
keep normal Git hooks enabled and create merge commits when integration is
needed. Already included commits are left alone. Feature branches are retained.

To update upstream between features, switch to `saturn/main` and run `sync`.
The older `bash scripts/sync-upstream.sh` entry point runs the same helper.
Run this regularly and before each deployment; there is no unattended merge job.

If Git reports conflicts, deployment remains stopped. Inspect `git status`,
resolve the conflicting files, run the relevant checks, stage only reviewed
files, and complete the merge with `git commit`. To abandon a pending merge,
run `git merge --abort`. If a hook fails, correct the reported problem and retry
or finish the pending merge after verification. Do not bypass hooks to hide a
failed check. After finishing a feature merge, run `sync` before deployment.

## Deploy from your laptop

Once the [one-time setup](README.md) is complete, review the merged changes and
run the required checks. Commit all intended source changes, then:

```bash
git switch saturn/main
make deploy
```

`make deploy` requires a clean checkout of `saturn/main`. It fetches upstream
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
fetch and review their commits, merge them into your local deployment branch,
repeat the relevant checks and upstream synchronization, then retry. Never
force-push away another contributor's work.

Review migrations before deployment. Keep a private record of the deployed
revision and backup; application rollback may require a compatible database
restore. The [public-fork policy](../../../docs/public-fork.md) also applies to
commit messages, source archives, build inputs, and other published artifacts.
