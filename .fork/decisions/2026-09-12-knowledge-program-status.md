# Knowledge platform program: implementation status

Index of the pull requests that implement
`.fork/plans/2026-09-07-company-knowledge-platform.md` (24 roadmap tasks) and
`.fork/plans/2026-09-11-knowledge-authorization.md` (11 authorization tasks, on
branch `docs/knowledge-authorization-plan`). Written so a reviewer can find the
change for any task without reconstructing it from branch names.

No roadmap checkbox is ticked. The plan requires a task's whole acceptance
boundary, not implemented code, and the cloud-dependent gates below have not
been executed. This record states what each remaining boundary needs.

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
| 30 | `integration/knowledge-platform` | Draft, every branch above merged and regenerated |
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
`.fork/plans/2026-09-07-company-knowledge-platform.md` section 3 records:
roadmap 05 from authz 09 and 11, roadmap 07 from authz 01 through 06, roadmap 08
from authz 07, roadmap 09 from authz 08.

## What no local run can close

Authorization task 11, restricted production verification, is the only task with
no pull request. It requires an operator-confirmed deployment target, a named
tester and credentials, so it cannot be started from a development machine. The
same boundary blocks four acceptance cases carried in PR 25: Google credential
sign-in, document answer latency, IAP boundary overhead, and ticket creation
against a deployed Kanban.

Three further gates are implemented but unexecuted, each for a stated reason
recorded in the owning pull request: the containerised browser suites for
roadmap 18 and 19 (the fixtures pin one set of ports, and concurrent agents held
them), and the MCP client gate in roadmap 22 (no intended client exists yet, so
the transport ships disabled behind an explicit flag, a release profile check and
a deployment variable refusal).

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

## Review order

Merge in pull request number order, or review the integrated tree at PR 30. The
authorization changes warrant review first: PR 24 installs triggers on Carbon's
`user` and `userToCompany` tables, and PR 27 changes which operations the public
API document and the tool catalogue disclose.
