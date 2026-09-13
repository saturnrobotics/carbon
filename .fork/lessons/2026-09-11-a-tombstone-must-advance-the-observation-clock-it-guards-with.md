# A tombstone must advance the observation clock it guards with

**Context:** The Carbon → portal projection (`persistCarbonChangePage`,
`packages/portal/src/sources/carbon.server.ts`) guards every entity write
with `entity."observedAt" <= EXCLUDED."observedAt"` so an older observation of
a row can never overwrite a newer one under at-least-once, out-of-order
delivery. The first tombstone statement set `deletedAt` but left `observedAt`
where the last upsert put it.

**Problem:** A delete observed at T2 followed by a redelivered upsert observed
at T1 (< T2) resurrected the row: the upsert compared against the STALE
`observedAt` (T0 from the original upsert), passed the guard, and cleared
`deletedAt`. The integration test proved it in one run; nothing static did.
The same bug shape exists in the sweep's range tombstone.

**Rule:** Any write that participates in an "only forward in time" guard must
move the clock it is guarded by — a tombstone sets `observedAt` to its own
observation time, exactly as an upsert does. When a table carries a monotonic
observation column, EVERY state transition writes it; a transition that skips
it is a hole the next out-of-order delivery falls through. Pin it with a test
that delivers `delete@T2` then `upsert@T1` and asserts the row stays deleted,
then `upsert@T3` and asserts it comes back.

**Applies to:** `persistCarbonChangePage` and `reconcileCarbonRange` in
`packages/portal/src/sources/carbon.server.ts`; any future source
projection into `portal.entity` or `portal.document` that dedupes by
observation time (Kanban tickets, generic engineering/CRM entities).
