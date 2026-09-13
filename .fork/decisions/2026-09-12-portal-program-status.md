# Portal platform program: implementation status

Index of the pull requests that implement
`.fork/plans/2026-09-07-company-portal-platform.md` (24 roadmap tasks) and
`.fork/plans/2026-09-11-portal-authorization.md` (11 authorization tasks).
Reconciled on 2026-09-13 against `saturn/main` at `7e03ef5e2d` and GitHub PR
states. Written so a reviewer can find the
change for any task without reconstructing it from branch names.

No roadmap checkbox is ticked. The plan requires a task's whole acceptance
boundary, not implemented code, and the cloud-dependent gates below have not
been executed. This record states what each remaining boundary needs. An open
acceptance checkbox does not mean the implementation is missing.

The subsequent [connected verification record](2026-09-13-portal-connected-verification.md)
adds fresh browser, real Carbon receiver/receipt, revocation and isolated recovery
proof, and records two verification-tool defects found and fixed. Consult its
limits before treating a deployment gate as closed.

## Current integration state

- [PR #30](https://github.com/saturnrobotics/carbon/pull/30) merged the platform
  program at `bcdc214a4b`; its stacked task PRs were merged or closed after
  integration. The table below is a provenance index, not an open-PR queue.
- [PR #56](https://github.com/saturnrobotics/carbon/pull/56) merged the nine Carbon
  connection repair PRs at `7e03ef5e2d`. All 15 reported checks passed. Its prior
  verification records 24 browser tests on each of three cold runs; broader
  ERP/actions suites include skips, which are not acceptance proof.
- PR #46 deliberately detached Carbon source-outbox triggers. The outbox table
  and consumer code exist, but ordinary source writes do not enqueue changes.
  No local fixture that reattaches triggers proves the shipped state is active.
- Configured Carbon structured reads and receipt-to-manual resolution may now
  coexist with manual search (PR #53/#56). Drive, vector retrieval, generated
  answers, commands, procurement and generic/MCP features remain deferred.

## Task map: implemented code versus remaining acceptance

These groups cover all 24 roadmap tasks. Historical task records and the PRs
below contain individual verification; this table does not claim a new run.

| Roadmap tasks | Implementation state | Remaining boundary |
| --- | --- | --- |
| 01–03 | Package contracts, release planner and selective Carbon deployment are implemented; #21 closes foundation gaps. | Verify the actual selected deployment's image/configuration closure and rollout behavior. |
| 04, 09 | Kanban work belongs to its separate repository and PRs below. | Reconcile its current trunk and prove its deployed authorization/cutover independently. |
| 05, 07–08 | Carbon identity and authorization implementations merged; see the authorization plan's per-task completion table. | Authz 11: real Google sign-in, assurance, private ingress, service IAM and receiver checks. |
| 06 | OAuth isolation evaluation and additional write-replay observations merged in #17; the selected IAP/trusted-forwarder design stands. | Do not reopen the design merely because its historical roadmap box is unchecked. |
| 10–11 | Portal schema, roles, generators and migration compatibility checks exist. #56 records fresh union regeneration and a clean second pass. | Apply and verify the selected deployment's schema/roles without resetting an existing database. |
| 12 | Source adapters, pricing transport and posted-receipt resolution merged through #56. | Exercise real Carbon receiver → receipt/items → applicable manual, including ambiguity, revocation and the known empty-source limitation. |
| 13–14 | Intake, extraction review and publication UI merged; #48/#56 repair title proposals. | Representative documents and cold upload → extraction → review → publish → search → exact download exercise. |
| 15, 17 | Index/outbox consumer and versioned cache/revocation implementations merged. | Carbon source triggers remain deliberately detached by #46; enabling propagation requires a separate decision and resynchronization plan. |
| 16, 18 | Retrieval, evidence assembly and portal implementations merged; local browser proof exists. | Real-corpus quality, ambiguity and performance remain unmeasured; vector retrieval and generated answers remain unreleased. |
| 19–22 | Drive, commands, procurement and generic/MCP implementations are retained behind release fences. | Separate enablement decisions and applicable end-to-end/provider/client acceptance. |
| 23–24 | Monitoring, budgets, retention, recovery tooling and acceptance harnesses exist. | Deployed alerts/budgets, restore with denied/deleted-document controls, rollout/rollback and restricted pilot acceptance. |

## Carbon pull requests

| PR | Branch | Task |
| --- | --- | --- |
| 10 | `docs/knowledge-authorization-plan` | Authorization plan document |
| 11 | `feat/knowledge-authz-10-provider-policy` | Authz 10, provider eligibility |
| 12 | `feat/knowledge-authz-06-session-tests` | Authz 06, session and entry paths |
| 13 | `feat/knowledge-authz-09-cloud-foundation` | Authz 09, cloud identity foundation |
| 14 | `feat/knowledge-authz-04-signature-tests` | Authz 04, real signature verification |
| 15 | `feat/knowledge-authz-01-enrollment` | Authz 01, identity enrollment |
| 16 | `feat/knowledge-13-typed-extraction` | Roadmap 13, immutable intake |
| 17 | `feat/knowledge-06-oauth-evaluation-gaps` | Roadmap 06, OAuth evaluation |
| 18 | `feat/knowledge-15-carbon-outbox` | Roadmap 15, Carbon source outbox |
| 19 | `feat/knowledge-17-cache-revocation` | Roadmap 17, caching and revocation |
| 20 | `feat/knowledge-authz-05-erp-receiver-wiring` | Authz 05, receiver deployment contract |
| 21 | `feat/knowledge-foundation-polish` | Roadmap 01, 11 and 23 gaps |
| 22 | `feat/knowledge-authz-03-assurance` | Authz 03, required assurance |
| 23 | `feat/knowledge-16-retrieval-gaps` | Roadmap 16, authorized hybrid retrieval |
| 24 | `feat/knowledge-authz-02-revocation` | Authz 02, revocation propagation |
| 25 | `feat/knowledge-24-acceptance` | Roadmap 24, acceptance and rollout |
| 26 | `feat/knowledge-14-intake-review-ui` | Roadmap 14, intake review interface |
| 27 | `feat/knowledge-authz-07-read-gate` | Authz 07, canonical read gate |
| 28 | `feat/knowledge-12-source-adapters` | Roadmap 12, bounded adapters; Roadmap 15 consumer |
| 29 | `feat/knowledge-19-drive-connector` | Roadmap 19, Google Drive connector |
| 30 | `integration/knowledge-platform` | Merged integration of the program and its repair branches |
| 31 | `feat/knowledge-18-routing-portal` | Roadmap 18, routing, synthesis, portal |
| 32 | `feat/knowledge-20-ticket-commands` | Roadmap 20, ticket commands, Carbon half |
| 33 | `feat/knowledge-22-adapters-mcp` | Roadmap 22, generic adapters and MCP |
| 34 | `feat/knowledge-21-procurement-drafts` | Roadmap 21, procurement proposals |

## Kanban pull requests

| PR | Branch | Task |
| --- | --- | --- |
| 1 | `feat/company-knowledge-platform` | Roadmap 09, board authorization |
| 2 | `feat/knowledge-authz-08-workforce-cutover` | Authz 08, workforce cutover |
| 3 | `feat/knowledge-20-ticket-commands` | Roadmap 20, ticket commands, Kanban half |

Roadmap identity checkboxes resolve through the authorization program as
`.fork/plans/2026-09-07-company-portal-platform.md` section 3 records:
roadmap 05 from authz 09 and 11, roadmap 07 from authz 01 through 06, roadmap 08
from authz 07, roadmap 09 from authz 08.

## What no local run can close

Authorization task 11, restricted production verification, has no completed
deployment evidence. It requires an operator-confirmed deployment target, a named
tester and credentials. Local preparation can proceed, but cannot close it. The
same boundary blocks four acceptance cases carried in PR 25: Google credential
sign-in, document answer latency, IAP boundary overhead, and ticket creation
against a deployed Kanban.

The formerly blocked roadmap 18/19 browser gates have since run: the harness now
accepts independent project names, image tags and ports, and #56 records the
combined cold suite. These local results do not prove a real Drive deployment.
The MCP client gate in roadmap 22 remains unexecuted: no intended client is
recorded, and the transport remains disabled behind the release fences.

## Findings that outlived their task

Two latent production faults were found by this work rather than introduced by
it, both in code that had never run against a real deployment.

The Kanban token verifier rejected the Google IAP issuer outright, and the API
image installed neither `google-auth` nor `cryptography`, so workforce mode would
have refused every request. Both are fixed in Kanban PR 2.

A raw purchasing operation was published as a callable tool taking a
caller-supplied authorization context, which would have let a caller assert its
own tenancy and permissions. It is blocked in Carbon PR 34.

A latency alert in the monitoring configuration read a nested payload field that
telemetry never emits, so it could not have fired. Fixed in PR 21.

## Next work and PR bookkeeping

Exercise the merged Carbon-connected workflow first, then resolve reproduced
failures and prepare the restricted deployment checks. Do not merge the original
task branches again or enable deferred features to clear roadmap checkboxes.

[PR #38](https://github.com/saturnrobotics/carbon/pull/38) was closed as superseded
on 2026-09-13 after review: its explicit re-enrollment, sticky-denial
assertions and cleanup are already in trunk. Its lesson is byte-identical; the
test has subsequently adopted #49's intentional 403 responses. The separately
reported monotonic-counter fixture issue is also repaired in
`packages/portal/scripts/test_revocation.py`. Merging the old branch is
unnecessary. Its old failed checks do not describe current trunk.

[PR #57](https://github.com/saturnrobotics/carbon/pull/57) remains an open handoff.
Update its pre-#56 integration instructions before retaining them as current
operator guidance.

The handoff additionally flags step-up errors classified as identity denials,
non-API-key bearer tokens entering the workforce path, the receiver's live-only
Google key fetching, and receipt reversal quantity semantics. Reproduce these
against the merged tree before proposing fixes. Runtime authentication changes
need their own review; a local verification seam must not become a release
authentication bypass.

## Follow-ups this program recorded but did not take

Each is small, is not required by any task's acceptance boundary, and is written
here so it survives the pull requests that found it.

The portal scripts invoke `corepack pnpm`, which fails wherever Corepack
resolves a pnpm other than the pinned one, and refuses to switch. Every agent
that hit it used a path shim rather than editing the scripts, since the call
appears in `packages/portal/scripts/setup-disposable.py` and several commands
in `verify-security.ts`. Those implementations have now merged. Diagnose the
current launcher before changing it and preserve the repository's pinned pnpm
version; merely preferring an arbitrary executable on PATH is not sufficient.

The backup schema manifest is generated from `information_schema.columns` with no
`ORDER BY`, so two machines regenerate byte-different files that are semantically
equal. `scripts/fork/regenerate.sh` hides this by restoring the committed bytes
when the comparison is semantically clean. Ordering the query would make
regeneration byte-stable, but column order also reaches real backup exports, so
the change needs its own review.

The fixed browser origins/ports/image-tag blocker was repaired in the merged
portal browser work; use the documented per-stack overrides and leave others'
stacks untouched. A remaining disposable-database setup constraint is that
`portal_resolve_workforce_identity` segfaults a Postgres backend when called
under `SET ROLE anon` unless the container sets `supautils.hint_roles` empty, as
the continuous integration configuration does.
