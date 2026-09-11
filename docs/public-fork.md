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

## Local deployment

Keep `origin` pointed at your public fork. `saturn/main` is the shared integration
and deployment branch; changes reach it through reviewed pull requests, and its
history is never rewritten.

`make deploy` runs from the laptop with a clean checkout of `saturn/main`. It
publishes the reviewed deployment revision to `origin/saturn/main` without
force-pushing, verifies anonymous source access, and uploads a Git archive of the
local commit to the deployment host for building. Publication is part of this
command; inspect committed changes for private content before running it. Private
runtime configuration is transferred separately and must never be part of the Git
archive. No-op releases perform no publication or cloud mutations.

Keep deployment-specific changes under `contrib/deploying/gcp-tailscale/` and
prefer focused additions over edits to upstream root files such as `README.md`.
The root `Makefile` is a small entry point; put deployment behavior in the
contributed scripts to reduce recurring upstream merge conflicts.
Keep fork-specific agent records in [`.fork/`](../.fork/README.md); avoid appending
fork-only lessons or task records to upstream's shared `.ai/` files.

Run the checks required by the touched packages' `AGENTS.md` files. Verify the
Google/domain and VPN restrictions whenever changes touch them. Review forward
migrations and backups before deployment, and keep a private record of the
deployed commit and backup. Application rollback may also require a compatible
database restore.

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
