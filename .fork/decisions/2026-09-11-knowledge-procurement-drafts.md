# Scheduled procurement drafts through Carbon (plan Task 21)

Implements Task 21 of `.fork/plans/2026-09-07-company-knowledge-platform.md` on top
of Task 18 (`feat/knowledge-18-routing-portal`), keeping the invariants in §2 of
`.fork/plans/2026-09-11-knowledge-authorization.md`. Local proof only: one
disposable `crbn` slot for this worktree, purged afterwards. No cloud resource was
touched and no developer stack was reset.

An earlier pass (commit `8272cbec75`, "knowledge base work step 1") had left a
first version of every file. This task audited that code against all seven plan
steps and replaced what did not hold.

## Decisions

- **The proposal stays a proposal until it is complete.**
  `packages/knowledge/src/commands/procurement.ts` now owns the whole
  interpretation layer: `interpretProcurementRequest` separates item identity and
  DIMENSIONS (`60x20`, `M6x20` — never read as a count) from quantity and
  purchase-unit hints, classifies each date phrase by the verb nearest to it, and
  returns clarifications instead of inventing anything. "Schedule purchase of
  60x20 stators for month end" therefore yields two clarifications (which
  quantity, and whether month-end is the arrival or the ordering date) and no
  command. `buildProcurementProposal` / `reviseProcurementProposal` carry an
  incomplete request across numbered versions under ONE id and idempotency key,
  and `toExecutableProcurementProposal` refuses while any clarification is open.
- **Dates are resolved on the business calendar, not the process clock.**
  `resolveProcurementDate` anchors on `today(businessTimezone)` through
  `@internationalized/date`; the same phrase typed at 23:30 in New York resolves to
  a different day than in UTC, and the test pins both. `requestedArrivalDate`,
  `proposedOrderByDate` and `executeAt` are three distinct fields end to end: the
  arrival date lands on `purchaseOrderDelivery.receiptRequestedDate`, the order
  date on `purchaseOrder.orderDate` (defaulting to `company_today`), and
  `executeAt` only decides WHEN the draft is created. Arrival before ordering is
  refused at every layer.
- **One canonical transaction, factored from the existing helpers.**
  `resolveProcurementDraft` (reads) + `createProcurementDraft` (one Kysely
  transaction) in `purchasing.service.ts` replace the earlier version. The reads
  are batched over the whole line set — items, current revisions, change orders,
  replenishment and supplier parts are one query each, so a hundred-line proposal
  is a fixed number of round trips. The exchange rate comes from the same
  `get_exchange_rate` resolver `insertPurchaseOrder` uses rather than an injected
  callback, the order date from the company's own calendar, and the unreleased-ECO
  rule is the same one `x+/purchase-order+/$orderId.new.tsx` applies. The proposal's
  UoMs, conversion factor and price are compared to `supplierPart` and refused as
  stale on a mismatch; they are never persisted as authority.
- **The knowledge outbox event comes from the trigger, not from the command.**
  The earlier version inserted into `knowledge.outbox` and read `knowledge.source`
  — neither exists in Carbon's schema (they live in the knowledge database), so
  that path could only ever have failed against a real Carbon database. Task 15's
  `knowledgeSourceOutbox` trigger on `purchaseOrder` already records the change in
  the command's own transaction, which the integration test asserts.
- **Authorization is rechecked where the write happens.**
  `actorCanCreatePurchasing` re-evaluates the actor's live employee membership and
  explicit `purchasing_create` grant (no `"0"` wildcard) on every command,
  immediate or scheduled. The wire validator recomputes the caller's
  `payloadHash` over the business content and refuses a payload that drifted from
  it, and `assertScheduleStillExecutable` refuses a changed payload, an
  unexecutable payload `version`, a cancelled row, or a schedule that is not due.
  There is ONE execution path: the scheduled run reaches the same
  `executeProcurementDraftCommand` through the canonical operation.
- **The raw purchasing transaction is not a published operation.**
  `purchasing_createProcurementDraft` was already in the generated manifest, and
  its second parameter is the `authorizedContext` — so an API-key caller could
  have supplied its own `companyId`, `actorId` and `canCreatePurchasing: true`.
  Both it and `purchasing_resolveProcurementDraft` are now in
  `MCP_BLOCKED_TOOL_NAMES` (the same precedent as `production_triggerJobSchedule`),
  leaving `knowledge_createProcurementDraft` — capability
  `carbon.procurement.draft`, permission `purchasing:create` — as the only
  exposure. `KNOWLEDGE_OPERATIONS` needed no change.
- **Scheduling persists a command reference, never a credential.**
  `apps/knowledge-actions/src/scheduled.ts` builds that reference and
  `assertNoDurableCredential` refuses one carrying an authorization header, token,
  assertion, cookie, or a self-asserted `actorId`/`companyId`. A lost Carbon
  response (transport failure or 5xx) is reconciled by re-sending the identical
  command under the same idempotency key, which the receipt turns into a replay;
  a 4xx is a decision and is reported, not retried.
- **Migration `20260912185440_knowledge-command-receipt-tenancy.sql`.** The
  receipt table kept a single-column primary key and had no index on either
  foreign key, unlike its sibling `knowledgeProcurementSchedule` and every other
  tenant-scoped table; it is now keyed on `("id", "companyId")` with
  `companyId`/`actorId` indexes, and carries the payload `version` the replay
  check reads.
- **The Draft/commitment boundary is unchanged.** The command creates status
  `Draft` only; nothing here submits, approves, releases or emails a supplier.

## Verification

Commands and their exact results (disposable slot at `127.0.0.1:55764`, all
migrations applied from scratch):

- `pnpm db:migrate` — migrations applied, types + swagger regenerated.
- `pnpm run generate:types` — `knowledgeCommandReceipt.version` added; no other
  table changed.
- `pnpm run generate:mcp && pnpm --silent check:manifest` — ok, 1562 operations
  across 16 modules, digest current (1563 → 1562: the two purchasing operations
  blocked, the knowledge operation's response shape updated).
- `pnpm --filter @carbon/knowledge test procurement` — 32 passed.
- `pnpm --filter knowledge-actions exec vitest run src/procurement.test.ts src/scheduled.test.ts`
  — 23 passed.
- `pnpm --dir apps/erp exec vitest run app/modules/knowledge/knowledge.commands.test.ts`
  — 19 passed.
- `PROCUREMENT_DRAFT_TEST_DATABASE_URL=… pnpm --dir apps/erp exec vitest run app/modules/purchasing/procurement-draft.integration.test.ts`
  — 19 passed against the real schema: one Draft PO with supplier defaults, line
  tax and one receipt; the outbox event written by the trigger in the same
  transaction; eleven refusals (cross-company supplier, inactive supplier,
  foreign location, superseded revision, stale factor/unit/price, arrival before
  ordering, non-positive and over-precise quantity, revoked permission, unreleased
  ECO) each leaving nothing behind; concurrent retries converging on one order and
  one receipt; a reused key with a changed payload refused; and fault injection on
  the receipt insert rolling back header, lines, delivery, payment, interaction
  and outbox. Row counts before and after a full run are identical.
- `pnpm --dir apps/erp exec vitest run app/modules/knowledge test/mcp-tool-permissions.test.ts`
  — 50 passed, 10 skipped (the RLS cases needing a Supabase stack).
- `pnpm --dir apps/erp exec vitest run "app/routes/api+/v1+/lib"` — 84 passed.
- `pnpm --filter @carbon/jobs exec vitest run src/procurement-schedule/core.test.ts`
  — 2 passed (the worker's claim/recheck path still holds against this boundary).
- `pnpm db:check:datasets` — 4/4 apply.
- `pnpm db:check:backups` — restorable; `-- --stage` refreshed the 364-table
  manifest baseline.
- `pnpm exec turbo run typecheck --filter=erp --filter=@carbon/knowledge --filter=knowledge-actions --filter=@carbon/jobs`
  — 5 tasks successful, 0 errors (`react-router typegen` must run first, or ERP's
  own `app/root.tsx` route types are missing).
- `pnpm exec biome check --error-on-warnings <14 changed paths>` — no diagnostics.

## Not done

- No browser proof: the command has no UI, and the portal's own surface is
  deferred with the rest of the commands release.
- `packages/jobs/src/procurement-schedule/*` (the claim/lease worker) and the
  Inngest wiring were left as they are — out of this task's file ownership. Its
  dispatch reaches the canonical operation, which is where the rechecks now live;
  its own integration suite still needs the labelled disposable fixture from
  `packages/knowledge/scripts/setup-disposable.py`, which was not run here.
- `pnpm generate:swagger` was not run on its own — `pnpm db:migrate` regenerates
  it, and the diff is confined to the new `version` column.
