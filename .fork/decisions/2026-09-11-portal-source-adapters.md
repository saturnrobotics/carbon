# Bounded source adapters, the motor/manual resolver, and the Carbon change consumer

**Date:** 2026-09-11
**Scope:** plan Task 12 (`.fork/plans/2026-09-07-company-portal-platform.md`)
and the worker-side remainder of Task 15.
**Base:** `feat/knowledge-17-cache-revocation` at `926fdd4757`, merged with
`feat/knowledge-15-carbon-outbox` (`82db6ac483`).

## What was found

The finite source contract (`sources/contract.ts`), the human transport with
its 1 s deadline, the generic engineering/CRM adapter, the raw Carbon and Kanban
clients in `registry.server.ts`, the receipt→manual resolver and the query
service's structured path all existed. What did not: adapters for Carbon and
Kanban that implement the six contract methods; a way to say "denied",
"unavailable" or "ambiguous" that is not an empty page; authenticated deep
links; business-timezone recency; any machine path from the worker to Carbon's
`portalSourceOutbox`; and the periodic sweep for trigger-silenced reloads.

## Decisions

- **Structured outcomes, not empty pages.** `sourceOutcomeSchema` carries
  `ok | ambiguous | not-found | insufficient-permission | unavailable`. The
  transport now throws a status-aware `SourceTransportError`, and every adapter
  method maps it: 401/403 → `insufficient-permission`, deadline → `unavailable`,
  anything else → `unavailable`. An ambiguity carries only rows the caller
  already received and a boolean `moreHidden` — never a count, never a hidden
  name. The query service renders these (`outcomeResult`) with the sentence
  "this is not an empty result" where a source did not answer.
- **Deep links belong to the owning app.** Carbon entities carry
  `fields.link` (`/x/part`, `/x/receipt`, `/x/purchase-order`); Kanban tickets
  carry their board URL. Carbon and Kanban authorize on open; the evidence keeps
  `observedAt` as its freshness stamp.
- **Machine admission is one module.** `verifyMachineRequest` moved to
  `@carbon/portal/machine-identity.server`; the worker's `machine-auth.ts`
  re-exports it, and Carbon's new route uses the same registration shape
  (`PORTAL_MACHINE_CALLERS_JSON`) with the same refusal of forwarded employee
  evidence.
- **Carbon's change feed is a route, not a database.** `POST
  /api/v1/portal/source-changes` (`apps/erp/app/routes/api+/v1+/`) is
  machine-only and deliberately outside the `$.ts` dispatch: that surface
  authenticates employees, and a source indexer is neither an API key nor a
  workforce identity. Its service module `portal.changes.server.ts` is not a
  `*.service.ts`, so nothing new enters the generated operation manifest or the
  `WORKFORCE_CAPABILITIES` allowlist (`base.server.ts` untouched).
- **A claim carries the projection Carbon shows now.** Reads are batched per
  entity type inside the claim; a receipt line lands on its receipt
  (`target`); an upsert whose row is no longer visible carries `entity: null`
  and is a tombstone for the consumer. Ordering between commits is never
  assumed: applying any change applies the newest observation, and an older
  observation cannot overwrite a newer one (`observedAt` guard on both upserts
  and tombstones).
- **Entity upserts do not enter the portal outbox.** `confirmOutboxApplied`
  only knows `document` and `intake`, so an `upsert` row for an entity would be
  leased by indexing delivery and could never be confirmed. The entity table's
  epoch trigger already bumps the source content epoch on every visible change.
  Tombstones and ACL changes DO enqueue outbox rows (`entityType: "entity"`,
  `delete` / `acl-change`), which the invalidation consumer leases with priority.
- **Reconciliation is a merge join, not a mark-and-sweep.** The sweep walks
  each entity type in keyset pages ordered `COLLATE "C"` on both databases;
  matching versions write nothing (an idle sweep moves no epoch), differing
  versions are re-projected, and rows Carbon no longer lists inside the page's
  own range are tombstoned. State lives in `portal.source.cursor.carbonSweep`
  and advances under an optimistic check.
- **"Recently received" is a business-calendar window.** The resolver takes
  `businessTimezone` and `recentDays` (90 in the query service) and reads a
  posting date as the company's calendar day, never a UTC instant.

## Gaps left open (see the PR body)

Kanban `getChanges` is implemented as a client of Kanban's cursor feed but no
worker function consumes it yet; `checkAccess` for Carbon items and Kanban
tickets fans out one bounded read per id (≤ 40, 8 in flight) because neither
source exposes a batched authorization read on this branch; a Kanban ticket's
column name for `queryFacts` comes from the caller's catalog read, not a
dedicated endpoint.

## Verification (local, synthetic containers `portal-t12-*` and the
worktree's own slot postgres; the developer's stack was not touched)

Recorded in the PR body's verification table.
