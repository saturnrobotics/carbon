# Maintaining a public self-hosted fork

Keep application improvements and reusable deployment code public. Keep company
operations and deployment inputs private. The root [agent guidelines](../AGENTS.md)
apply to all contributions, including agent-generated plans and run logs.

## Private inputs and public examples

Use synthetic records and `example.com` in source, tests, documentation, screenshots,
and examples. Do not check in real business records, employee/customer/supplier
details, private domains or email addresses, cloud project IDs, tailnet membership,
OAuth credentials, tokens, private keys, database dumps, or production logs.

Keep operator-specific deployment files under
`contrib/deploying/gcp-tailscale/.local/` (ignored), or outside the checkout. Keep
runtime credentials in the deployment's secret store. Publish generic templates and
all code needed to reproduce the application; load the actual values at runtime.
Ignored files still need normal access controls and private backups.

Before every commit or PR, inspect `git diff`, `git diff --cached`, and untracked
artifacts. Review commit messages and PR text too. Never use `git add -f` for private
inputs. Ignore rules cannot remove a file already tracked or erase previous commits.
If private content is found, stop publication and address the exposure privately;
revoke any exposed credentials and coordinate any necessary history cleanup.

## Upstream updates

Keep `origin` pointed at your public fork. Configure the upstream repository once:

```bash
git remote add upstream https://github.com/crbnos/carbon.git
```

If `upstream` already exists, inspect it with `git remote get-url upstream` before
changing it. Keep custom features in focused commits and integrate them through the
fork's `main` branch. Do not reset the fork to upstream or force-push away changes.

For each update, start with a clean checkout of your fork's latest `main`:

```bash
git switch main
git pull --ff-only origin main
bash scripts/sync-upstream.sh
```

The helper fetches `upstream/main`, creates `sync/upstream-<commit>`, and prepares a
merge with `--no-commit --no-ff`. This deliberately leaves a reviewable pending
merge even when a fast-forward would otherwise be possible. It does not commit,
push, deploy, or move `main`. If the upstream revision is already included, it exits
without creating a branch. See the [Git merge documentation](https://git-scm.com/docs/git-merge).

Review both upstream release notes and the merge, especially authentication,
dependencies, migrations, licensing, and the deployment configuration. Resolve
conflicts while retaining the fork's privacy and access restrictions. For generated
database types, resolve the schema first, apply pending migrations to a disposable
development database, and run `pnpm run generate:types`; never hand-edit generated
types or reset a database to resolve a source conflict.

Run the checks required by the touched packages' `AGENTS.md` files. At minimum,
verify the deployment scripts and the Google/domain and VPN access restrictions
when upstream changes touch them. Commit the reviewed merge, publish the review
branch to the fork, and merge it through your normal PR process after validation.
Take a database backup and inspect forward migrations before deploying the resulting
revision. Keep a private record of the deployed commit and backup. An application
rollback may also need a compatible database restore.

To stop a pending merge, run `git merge --abort`, then `git switch main`. The helper
keeps the review branch available; inspect it before deciding whether to remove it.
It never selects a conflict resolution on your behalf.

## Source availability and licenses

Preserve the repository's [LICENSE](../LICENSE), upstream copyright notices, any
`NOTICE` files, and third-party notices when merging or distributing artifacts.
Carbon's license file includes commercial terms for `packages/ee` and files with
`.ee` in their names; a public fork alone does not grant those commercial rights.
Review the applicable terms before enabling enterprise features. This maintenance
workflow does not change their license or bypass license checks.

Section 13 of the included AGPL text addresses source access for users interacting
with a modified program over a network. Keep the fork public and provide a prominent
source link from the deployed application to the exact deployed revision, including
the modifications and corresponding build/install source. Verify that a user can
retrieve that source without credentials. Retain the matching revision when deploying
an older build. VPN restrictions on the running application do not replace the
source offer. The optional `SOURCE_CODE_URL` environment variable displays a
"Source code" link on the ERP and MES login pages; set it to a public HTTPS URL for
the deployed commit, without embedded credentials. Leaving it unset preserves the
existing login layout. Review [Carbon's license](https://github.com/crbnos/carbon/blob/main/LICENSE)
for the applicable terms; this checklist is an operational convention, not a legal
conclusion about every licensing scenario.
