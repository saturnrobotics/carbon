# Carbon portal source outbox (plan Task 15, Carbon half)

Context: the portal platform plan (`.fork/plans/2026-09-07-company-portal-platform.md`,
Task 15 step 4) requires a source-owned transactional outbox in Carbon. The Kanban
half already existed; the Carbon half (migration, consumer helpers, integration
proof) did not.

Decision: Carbon records portal events with reviewed `AFTER ROW` triggers on the
four tables the bounded portal reads project from — `receipt`, `receiptLine`,
`item`, `purchaseOrder` — into `public."portalSourceOutbox"` (migration
`20260911205347_knowledge-source-outbox.sql`), in the same transaction as the
business write. No Inngest or post-commit notification substitutes for it.

- One trigger function decides per table which changes a reader can observe:
  a receipt entering, changing while in, or leaving `Posted`; a line only while its
  receipt is posted; the item identity/revision projection; the purchase status
  projection. Everything else returns without a row.
- The dedupe identity is `UNIQUE (companyId, source, entityType, entityId,
  sourceVersion, eventType)`, the same shape the portal outbox and worker use.
- `sourceVersion` is the row's bumped `updatedAt` (UTC, microseconds, as text). A
  write that does not bump `updatedAt` is versioned by `pg_current_xact_id()` so
  it can never be merged into an already delivered event. That identity is used
  for dedupe only; no ordering between commits is assumed.
- A duplicate of a pending identity is one row; a duplicate of an already
  delivered identity re-arms that row rather than creating a second.
- Payloads carry references only (a line's `receiptId`), bounded to 4 KiB.
- The trigger is `SECURITY DEFINER` (like `sync_webhook_subscription`) because
  app roles have no INSERT policy; employees with `purchasing_view` may SELECT and
  nothing else. Delivery state is maintained server-side through Kysely.
- The trigger skips under `app.sync_in_progress` exactly like
  `dispatch_event_batch`, and backup restore runs under
  `session_replication_role = 'replica'`, so bulk reloads are reconciled by the
  consumer's periodic sweep instead of replayed row by row.
- `portal.events.server.ts` claims with `FOR UPDATE SKIP LOCKED`, a
  five-minute lease, tombstones/ACL changes first, and acknowledges only while
  the caller still holds a live lease; a lost lease throws.

Verified outcome (local slot database provisioned for this worktree, all
migrations applied from scratch):

- `portal.outbox.integration.test.ts`: a rolled-back posting leaves no row; a
  committed one leaves exactly one; a replayed write and a duplicate identity
  dedupe; leases exclude other workers, expire, and a lost lease cannot
  acknowledge; tombstones are claimed before upserts; draft-receipt lines are
  silent (4/4).
- `pnpm db:check:datasets` 4/4, `pnpm db:check:backups` restorable,
  `@carbon/portal` indexing 5/5, `portal-worker` 27/27, Kanban `test-api`
  34 passed / 1 skipped.
- The MCP tool digest changed only because the generated `Database` type gained a
  table: regenerating it against the base types reproduces HEAD byte for byte.

Not done here: a Carbon-side consumer that carries these rows into
`portal.outbox` (the worker's adapter), and the periodic reconciliation sweep.
Both are later layers of the same task family and read this table as-is.
