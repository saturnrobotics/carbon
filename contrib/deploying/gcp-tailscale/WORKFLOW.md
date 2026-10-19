# Local deployment

`saturn/main` is the shared integration and deployment branch. Keep `origin`
pointed at the public fork. Changes reach `saturn/main` through reviewed pull
requests; its history is never rewritten and it is never force-pushed.

Keep custom deployment code and operator documentation under this directory.
Avoid changing upstream root files such as `README.md` when a local document or
wrapper can do the job. The existing root `Makefile` remains a small entry point
for `make deploy`. Fork ERP/MES and ops builds use root `Dockerfile.saturn`;
root `Dockerfile` stays unchanged from upstream. Portal builds keep their own
Dockerfiles. Put actual operator settings only in ignored `.local/` files.

## Deploy from your laptop

Once the [one-time setup](README.md) is complete, review the merged changes and
run the required checks. Commit all intended source changes, then:

```bash
git switch saturn/main
make deploy
```

`make deploy` requires a clean checkout of `saturn/main` and successful CI for its
exact revision before publication or cloud mutations. The verifier uses GitHub's
public API; unavailable or incomplete evidence blocks deployment by default.
For an explicit operator override of GitHub CI-status checks, use:

```bash
make deploy FORCE=1
# Equivalent flag spelling (the first -- belongs to Make):
make deploy -- --force
```

The underlying script accepts `deploy.sh --apply --force`. This skips all required
GitHub workflow/job status checks, including missing, pending or failed results;
it does not report them as successful. Source branch/cleanliness, ordinary source
publication and public-download checks, dependency/build checks, snapshots,
migrations and rollout health/recovery checks remain active. The override is
printed when used and is not stored in deployment configuration. Do not put
`FORCE=1` in your shell environment or Make defaults.

A no-op release still returns without publication, verification-network calls,
or cloud mutations. Force applies only to the two deployment targets, not
`deploy-check`, `deploy-plan` or other Make targets.

For a changed release, the command
publishes the exact deployment commit to `origin/saturn/main` using an ordinary
push and checks that its source can be downloaded publicly. You do not need to
push in a separate step. Review committed changes for private data before running
the command: deployment publishes those commits.

`make deploy` generates private release inputs and automatically chooses the
routine or coordinated snapshot/migration rollout, including initial release
tracking setup. No hand-written manifest or separate baseline command is needed.
`make deploy-check` and `make deploy-plan` are optional diagnostics. See
[the deployment guide](README.md#automatic-release-preparation) for rollout details.

For a slow or unexpectedly broad release, inspect the freshly generated private
preview and its changed-input explanations. An old preview is not current VM
evidence. Keep unchanged services at their recorded image/source identity; never
force a shared revision onto all services or replace the deployed baseline with
the current checkout to suppress builds. Merged upstream changes are compared
through their final content and dependency graph. Base-image updates require a
reviewed `Dockerfile.saturn` digest change. Preserve the conservative maintenance path for
database/authentication/platform changes whose rolling compatibility is unproven.

The command archives the committed source on your laptop and uploads it to GCP
for the build and deployment. Private `.local/` configuration is transferred
separately. Uncommitted files are never included in the source archive. The
application's source link identifies the exact deployed revision.

## Private load balancer mode

With `INGRESS_MODE=private-lb` the first command on a copied data disk is
`make deploy-adopt`, then `make deploy-maintenance`; later releases use
`make deploy` as usual. Adoption requires the same clean, CI-verified
`saturn/main`, publishes nothing and starts nothing. Deployment in this mode
writes no DNS records and stops before any change when the VM, its network,
address, service account, data disk or exact ingress allowlist is missing. See
[private load balancer mode](README.md#private-load-balancer-mode).

PostgreSQL archives WAL with WAL-G in this mode. After the first maintenance
release with archiving, take the first base backup on the VM at once
(`sudo systemctl start carbon-wal-g-backup.service`); a timer takes one daily. See
[WAL-G archiving](README.md#wal-g-archiving-and-base-backups).

If publishing is rejected because someone else updated `origin/saturn/main`,
fetch and review their commits, pull them with `git pull --ff-only`, and retry.
Never force-push away another contributor's work.

Review migrations before deployment. Keep a private record of the deployed
revision and backup; application rollback may require a compatible database
restore. The [public-fork policy](../../../docs/public-fork.md) also applies to
commit messages, source archives, build inputs, and other published artifacts.
