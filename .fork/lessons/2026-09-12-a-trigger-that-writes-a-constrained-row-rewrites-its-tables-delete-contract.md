## A trigger that writes a constrained row rewrites its table's delete contract

**Context:** A new `AFTER INSERT OR UPDATE OR DELETE` trigger on `receipt`,
`receiptLine`, `item` and `purchaseOrder` recorded a knowledge event into a new
table whose `companyId` references `company` with `ON DELETE CASCADE`.

**Problem:** Deleting a company cascades to those source tables, so the trigger
ran for every child row *after* the `company` row it referenced was gone, and its
INSERT failed the new foreign key — aborting `DELETE FROM "company"` entirely.
The delete is a real production path (`settings.service.ts` `deleteSubsidiary`,
reached from the Settings UI) and the shape every integration fixture in the repo
uses for teardown, so the regression surfaced as dozens of unrelated suites
failing on a constraint named after a table they never touch. The feature's own
suite passed, because its teardown happened to delete the source rows table by
table before the company.

**Rule:** Attaching a write to an existing path makes every caller of that path a
caller of the write, including the ones a cascade or another trigger invokes.
Before adding one, enumerate the paths that already touch the table — the whole-
tenant cascade above all — and decide explicitly what the new write does on each.
When the new row cannot legally exist, add a precondition that names the state
(`IF NOT EXISTS (SELECT 1 FROM "company" …)`), never an exception handler that
swallows the error; and prove the alternative rather than assuming it — dropping
the constraint here was measured and leaves a surviving row for a tenant and an
entity that no longer exist. Verify against a suite that exercises the existing
paths, not only the new feature's own tests, whose fixtures may be written around
the new behaviour.

**Applies to:** database triggers that INSERT into another table, especially one
carrying a `companyId` foreign key; also any new NOT NULL column, CHECK, or
constraint added to a table that an existing cascade, backfill, or restore writes.
