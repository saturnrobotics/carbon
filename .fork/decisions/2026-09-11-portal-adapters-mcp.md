# Generic engineering/CRM adapters, a reusable conformance suite, and the optional MCP transport

**Date:** 2026-09-11
**Scope:** plan Task 22 (`.fork/plans/2026-09-07-company-portal-platform.md`),
§1.9 invariants, §1.10's "MCP is an optional transport over the same typed
handlers", A14 and A15; the authorization invariants in
`.fork/plans/2026-09-11-portal-authorization.md` §2.
**Base:** `feat/knowledge-18-routing-portal` at `c4f21efc4f`.

## What was found (gap audit against the five steps)

| Step | Present on the base | Gap filled here |
| --- | --- | --- |
| 1 Synthetic engineering/CRM examples | `createGenericReadAdapter` (five wire methods) and the `engineering`/`crm` registry kinds; the only fixture was a single inline `pcb` object in `conformance.test.ts` | `engineering.example.ts` (versioned machine/PCB designs: revision lists, approved-vs-draft projection, unit-carrying fields, attachments with immutable version ids, revision deep links) and `crm.example.ts` (customers/contacts with an account-team boundary INSIDE the company); both served by a shared in-memory producer (`synthetic-producer.ts`) implementing the owner side of the contract |
| 2 Declarative registration | a registry keyed by `kind` with a hand-written `switch`; capabilities, freshness, pagination, rate limits and events were implicit in each adapter's code | `sourceAdapterDescriptorSchema` (`sources/contract.ts`) and `SOURCE_ADAPTERS` (`registry.server.ts`): one frozen row per kind naming capabilities, schema version, auth policy, filters, projected fields and facts, freshness, pagination, rate limits, events/deletion and the deep-link field. `registry.describe(sourceId)` is the one read |
| 3 Reusable conformance suite | `conformance.test.ts` asserted schema shapes only — no producer was ever driven | `sources/conformance.ts`: `runSourceConformance(fixture)` drives a producer through the SAME registry and generic adapter the query service uses, 17 named checks (bounded search, cursor walk, deep links, boundary, immutable revision, denial-vs-not-found, declared/undeclared facts, document references, ACL subset, deletion, tombstone feed, machine-only ingress, rate limit) |
| 4 MCP over the reviewed handlers | nothing; `@modelcontextprotocol/sdk` exists only in `apps/erp` | `packages/portal/src/mcp/` (surface, delegating transport, deployment gate) + `apps/portal-query/src/mcp.ts` and `apps/portal-actions/src/mcp.ts`, each a ~10-line wiring of its own route table |
| 5 Disabled until auth + parity pass | n/a | `isMcpEnabled` requires the exact flag AND a release profile past `manual-v1`; `release.py` independently refuses the variable; documented in `contrib/deploying/portal/README.md` |

## Decisions

- **A descriptor is data next to the factory, not a comment.** Everything the
  router or a test may assume about a source is one frozen row in
  `SOURCE_ADAPTERS`, validated by a zod schema with two cross-field refinements
  (a `changes.feed` capability and a non-`none` events feed must agree;
  tombstone deletion requires a `delete` event type). `factValiditySeconds` is
  bounded by the shared 15 s live-fact rule, so a producer cannot declare
  staler freshness than §1.8 allows. Adding a producer kind is adding a row.
- **The conformance suite drives the real adapter, not a mock of it.** It
  constructs a `createSourceRegistry` over the fixture's connection and calls
  `registry.generic(...)`, so a producer that passes it is one the query
  service can consume with **no router change** — that is the A15 claim, and it
  is the reason the suite refuses to talk to the producer directly.
- **Both examples are built to fail a lazy test.** The engineering producer
  keeps a draft revision that must never be projected, an obsolete one that
  must not be resurrected, and a second company's board; the CRM producer's
  boundary is the ACCOUNT TEAM, so `alice` is denied a customer in her own
  company. A suite that only checked cross-company isolation would pass while
  the intra-company boundary leaked. The suite additionally asserts a negative
  result on itself: a wrapper that widens `access/check` by one id makes
  `access.subset` fail with the adapter's own "expanded" refusal.
- **A denial is never a 404 and a tombstone carries no row.** `getEntity` on an
  out-of-boundary record must raise `SourceTransportError("denied")`; on a
  deleted one, status 404 — and the deleted id must also leave the search page
  and `access/check`. The delete event's `entity` is null, and a test asserts
  the serialized tombstone contains none of the contact's PII.
- **MCP is a delegating transport, so parity is structural.** A tool is a
  POINTER: the operation name its HTTP route verifies, the path it delegates
  to, and the JSON Schema of that route's own validator. `createMcpHandler`
  turns a `tools/call` into the same `Request` the route would have received
  and hands it to the handler the service already mounts, so identity,
  caller authorization, budgets, rate limits and idempotency are not
  reimplemented and cannot drift. A tool whose path a service does not mount is
  neither listed nor callable there — which is why the query app's table holds
  only `/v1/query` and the actions app's only `/commands/tickets`.
- **No new dependency.** The transport is plain JSON-RPC 2.0 over HTTP
  (`initialize`, `notifications/*`, `tools/list`, `tools/call`; everything else
  is `-32601`). `@modelcontextprotocol/sdk` is an `apps/erp` dependency and is
  not resolvable from `packages/portal`; adding a production dependency was
  out of scope for this task, and a delegating server needs none.
- **Cookies are not an MCP credential.** The client presents the ordinary
  machine pair as HEADERS (receiver-audience service token, user evidence,
  company). A request carrying only a cookie is 401 BEFORE any handler runs,
  and the delegated request is built from an ALLOWLIST — so `cookie`,
  `x-portal-actor-id`, `x-serverless-authorization` and a forged
  `x-goog-iap-jwt-assertion` never cross. An allowlist rather than a denylist
  because a future header nobody predicted must default to "not forwarded".
- **A single-implementation refactor in the actions app.** Both command
  branches of `apps/portal-actions/src/index.ts` became named route
  functions (`ticketRoute`, `procurementRoute`) which the HTTP dispatch and the
  MCP table both call. Duplicating the dependency construction for MCP would
  have been exactly the alternate execution path §1.10 forbids. No behaviour
  change; `server.ts`, `ticket.ts` and `procurement*.ts` are untouched.
- **Two independent locks, plus a third outside the app.** `isMcpEnabled`
  demands the exact string `true` AND a release profile other than `manual-v1`;
  `release.py` rejects the unknown variable as deferred configuration. So the
  transport cannot reach a deployed revision on one env edit, which is what
  "disabled until a client passes auth and parity tests" has to mean.

## Verification (local, synthetic; no containers were needed and none were created — the developer's stack and the shared `portal-manual-local-*` project were untouched)

Recorded in the PR body's verification table.

## Not done

- **No real MCP client was exercised.** The parity and auth proofs are unit
  level; step 5's gate (an intended client authenticating against the deployed
  services) is a production-verification item and remains open. The transport
  stays undeployable until then, by the three locks above.
- **`apps/portal-actions/src/mcp.ts` mounts the ticket command only.** The
  procurement draft is deliberately absent from `MCP_TOOLS`: Task 21's
  `/commands/procurement` is a Draft-PO write whose review boundary is the
  portal, and nothing has reviewed it for a machine transport.
- The generic change feed (`createGenericChangeFeed`) has no worker function
  consuming it yet — the same gap Task 12 left open for Kanban.
