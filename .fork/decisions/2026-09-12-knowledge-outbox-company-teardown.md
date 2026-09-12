# Knowledge source outbox and the company teardown cascade

Context: `20260911205347_knowledge-source-outbox.sql` (fork decision
`2026-09-11-knowledge-15-carbon-outbox.md`) attached an `AFTER ROW` trigger to
`receipt`, `receiptLine`, `item` and `purchaseOrder`. The Saturn invoice check
then failed across the invoicing, items and jobs integration suites with
`knowledgeSourceOutbox_companyId_fkey` — a constraint none of those suites
reference.

Mechanism: deleting a company CASCADEs to all four source tables. The trigger
runs for each cascaded child row after the `company` row it references has
already been removed, so its INSERT violates the outbox's own `companyId`
foreign key and aborts the delete. Every fixture in the repository tears down
with a bare `DELETE FROM "company"`, and so does production —
`settings.service.ts` `deleteSubsidiary`, reached from
`x+/settings+/companies.delete.$id.tsx`.

Decision: the trigger was wrong, not the fixtures and not the constraint.

- The fixtures create the company they delete; the delete is the supported
  whole-tenant cascade, which `20260827112750_prevent-item-delete-with-inventory.sql`
  had already reasoned about and deliberately preserved.
- Every source table declares `companyId` NOT NULL with its own foreign key, so a
  company-wide cascade is the only state in which the trigger can observe a change
  whose company is absent.
- The event is unrecordable rather than inconvenient: it names a company, an
  entity and an outbox row that the same statement is deleting. Dropping the
  foreign key was measured, not assumed — without it the trigger leaves a
  surviving `item`/`delete` row for a company and an entity that no longer exist,
  which the cascade can no longer reclaim and a consumer would lease forever. The
  constraint is also the repository's own convention for a `companyId` column.

Fix: `20260912194512_knowledge-source-outbox-company-teardown.sql` replaces
`knowledge_source_outbox_enqueue()` with the same body plus one precondition
immediately before the INSERT — return without a row when the company no longer
exists. It is a precondition, not an error handler: nothing is caught and nothing
is suppressed, a qualifying change to a live company still records exactly one
event, and a write whose event cannot be recorded still fails loudly. The lookup
sits after the per-table gates, so a non-qualifying write pays nothing for it, and
it reads `company` as the function's `SECURITY DEFINER` owner, which the caller's
row security does not apply to — verified by probe, a company invisible to
`authenticated` directly is visible inside the definer.

A new migration rather than an edit to `20260911205347`: that version is already
recorded in the migration ledger of every database that has applied it, so an
in-place edit would silently leave those with the old function.

Verified outcome (disposable local container, all migrations applied from
scratch, removed afterwards):

- Regression pinned red→green in `knowledge.outbox.integration.test.ts`: a bare
  company delete over qualifying rows on all four source tables aborts with the
  reported error on the pre-fix function and leaves no outbox rows with the fix.
  A second test pins the other side — a company created and seeded in one
  uncommitted transaction still records its events, so the guard cannot mistake
  an unseen company for a deleted one.
- ERP invoice integration 43/43 (was 30 failed / 13 passed), jobs invoice and
  payment-sync integration 101/101, outbox 6/6, `@carbon/knowledge` indexing 5/5,
  `knowledge-worker` 27/27.
- `db:check:datasets` 4/4, `db:check:backups` restorable, scoped typecheck for
  `erp`, `@carbon/database` and `@carbon/knowledge` clean.
- Generated artifacts unchanged: the migration replaces a function and adds no
  table, column, view or RPC, so `generate:types` produced no diff and the MCP
  digest, backup manifest and swagger schema are untouched.

Not done here: the consumer that carries these rows into `knowledge.outbox` and
the reconciliation sweep remain later layers, as the original record says.
