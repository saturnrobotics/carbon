# Portal versioned caching, invalidation and revocation

**Date:** 2026-09-11
**Scope:** Task 17 of the company portal platform plan (§1.8).
**Base revision:** `feat/knowledge-authz-10-provider-policy` at `2dee38be02`.

## What was found

The layered exact cache, policy revalidation on every hit, in-flight coalescing,
TTL jitter and the fail-closed policy path already existed
(`packages/portal/src/cache/*`, `apps/portal-query/src/query.server.ts`).
Source epochs advanced only through database triggers on local tables. Nothing
consumed the outbox for invalidation, so a connector delete, an external ACL or
board change, a correction or a new index generation could not reach a warm
key until its TTL expired. The Verify command
`pnpm --filter @carbon/portal test:integration revocation` matched no file
and failed. The portal had no sign-out and no follow-up context model.

## What changed

- `claimOutbox` takes an `eventTypes` partition and now returns rows in the
  priority it locked them in. Its `UPDATE … RETURNING` did not preserve the
  locking CTE's `ORDER BY`, so "revocations first" only chose which rows fit the
  limit; an ordinal now carries the order through.
- Migration `20260911210128_outbox-invalidation-event-kinds.sql` widens the
  outbox `eventType` CHECK with `correction`, `board-change` and
  `index-version`. Generated types are unchanged (column-only introspection).
- `packages/portal/src/cache/epochs.server.ts`: `INVALIDATION_EVENT_TYPES`,
  `planInvalidation` (order- and duplicate-independent, ACL bumps first) and
  `bumpSourceEpochs` (one set-based UPDATE under the ingestion role's policy).
- `apps/portal-worker/src/invalidation.ts`: `portal-outbox-invalidation`,
  an Inngest v3 function on the separate portal client. It leases only the
  invalidation kinds; indexing delivery now leases `upsert` only, so the two
  consumers never contend. Epochs move before any confirmation or
  acknowledgement; document tombstones and ACL changes are confirmed as
  delivery confirmed them; a failed event is deferred to lease expiry and the
  reconciliation cron rather than wedging the batch.
- `apps/portal-query/src/cache.server.ts`: the scope, policy and evidence
  re-authorization extracted from `query.server.ts` without behavior change.
- `packages/portal/src/query/conversation.ts`: `conversationState` holds
  evidence ids only; `reauthorizeConversationState` restores it whole or not at
  all, for the same actor and company, through the caller's policy check.
  There is no conversation store yet, so it has a unit test and no call site.
- Portal: `/logout` (303 to the IAP clear-login-cookie handler on this origin
  with `Clear-Site-Data: "cache", "storage"`, `no-store`), `private, no-store`
  on the home document, `key={scope}` remount of the query view when the
  company scope changes, and a bfcache `pageshow` reset of shown results.

## Verification (local, synthetic containers `portal-t17-*`, no dev stack)

- `pnpm --filter @carbon/portal test cache` — 2 files, 8 passed.
- `pnpm --filter @carbon/portal test:integration revocation` — 6 passed:
  warm-cache binding revocation, newly matching document invalidating an empty
  result set (trigger epoch), reordered and duplicated outbox invalidation
  through real `portal_ingest` row policies, Redis loss → authoritative read,
  policy-store loss → deny with a warm envelope, cross-user attack denied
  without a compute and without the owner's key ever being derived.
- `pnpm --filter @carbon/portal test` — 28 files, 128 passed.
- `pnpm --filter @carbon/portal test:integration` — 37 files, 146 passed
  (with `PORTAL_TEST_CONTAINER` pointed at the task's container).
- `python3 packages/portal/scripts/test_epochs.py`, `test_schema.py`,
  `test_function_boundary.py` — 3, 20, 4 passed.
- `pnpm --filter portal test` 24, `portal-query test` 30,
  `portal-worker test` 30 passed; query integration pair 4 passed.
- `pnpm exec biome check --error-on-warnings` on 21 changed files — clean.
- `pnpm exec turbo run typecheck` for the four portal packages — clean.
- `generate:types` after the migration: identical to the committed file.

Not run: the docker manual-workflow browser e2e (`local-stack.sh test`); it
registers the new function in `local-ingest.ts` and runs in `portal-check`.
