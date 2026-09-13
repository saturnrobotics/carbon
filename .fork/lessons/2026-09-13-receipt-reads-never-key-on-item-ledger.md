# Receipt reads never key on the item ledger

**Context** — A read that answers "what did we just receive?" needs the item, the
quantity that landed, and the lot or serial. `itemLedger` looks like the right
source: it is the source of truth for on-hand quantity, it carries
`trackedEntityId`, and it has a `documentLineId` column.

**Problem** — `documentLineId` was added for material issuing, and issuing is the
only writer. `post-receipt` sets `documentId` (the receipt) and never the line, so
a lookup keyed on the receipt line returns nothing for a genuinely posted receipt —
which reads as "the source is incomplete" rather than "this join was never
populated". It is also a NARROWER gate than posting: no ledger row is written for
an outside-processing line or for an item whose tracking type is not
Inventory/Batch/Serial, so those posted lines would be dropped even with the key
recorded. And a test seeded by inserting ledger rows by hand proves none of this.

**Rule** — Derive a receipt answer from the receipt line, not from the ledger.
`receipt.status = 'Posted'` is the posting evidence, because `post-receipt` flips
the status and inserts the ledger rows in one Kysely transaction.
`receiptLine.receivedQuantity` is the number the ledger rows are computed from.
The lot or serial is the tracked entity whose `attributes->>'Receipt Line'` names
the line — the same join `post-receipt` itself uses to stamp
`itemLedger.trackedEntityId`. Exclude entities carrying `Split From Entity ID`: a
batch split clones the parent's attributes, so a split child names the same receipt
line. Before adding a column to a projection because a table "has" it, find the
writer and confirm it is set on the path you care about.

**Applies to** — any read over `itemLedger.documentLineId`; portal receipt reads
in `apps/erp/app/modules/portal/`; new projections over receipts, shipments or
any other document whose ledger rows are keyed by document rather than by line.
